const EventEmitter = require('events');
import * as Types from './kafkaInterface';
import CascadeProducer from './cascadeProducer';
import CascadeConsumer from './cascadeConsumer';
import { rejects } from 'assert/strict';
import { resolve } from 'path/posix';
import { emit } from 'process';

// kafka object to create producer and consumer
// service callback
// dlq callback -> provide default
// success callback
// topic
// retry producer
// topic consumer
// retry levels -> provide default
// retry strategies per level

class CascadeService extends EventEmitter {
  kafka: Types.KafkaInterface;
  topic: string;
  serviceCB: Types.ServiceCallback;
  successCB: Types.RouteCallback;
  dlqCB: Types.RouteCallback;
  retries : number;
  topicsArr : string[];
  producer: CascadeProducer;
  consumer: CascadeConsumer;
  timeout: number;

  events = [ 
    'connect',
    'disconnect',
    'run',
    'stop',
    'pause',
    'resume',
    'receive',
    'success',
    'retry',
    'dlq',
    'error'
  ];

  constructor(kafka: Types.KafkaInterface, topic: string, groupId: string,
    serviceCB: Types.ServiceCallback, successCB: Types.RouteCallback, dlqCB: Types.RouteCallback) {
      super();
      this.kafka = kafka;
      this.topic = topic;
      this.serviceCB = serviceCB;
      this.successCB = successCB;
      this.dlqCB = dlqCB;
      this.retries = 0;
      this.topicsArr = [];


      // create producers and consumers
      this.producer = new CascadeProducer(kafka, dlqCB);
      this.producer.on('retry', (msg) => this.emit('retry', msg));
      this.producer.on('dlq', (msg) => this.emit('dlq', msg));
      this.consumer = new CascadeConsumer(kafka, topic, groupId, false);
      this.consumer.on('receive', (msg) => this.emit('receive', msg));
  }

  connect():Promise<any> {   
    return new Promise(async (resolve, reject) => {
      try {
        await this.producer.connect();
        await this.consumer.connect();
        this.emit('connect');
        resolve(true);
      }
      catch(error) {
        this.emit('error', 'Error in CascadeService.connect: ' + error);
        reject(error);
      }
    });  
  }

  disconnect():Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        await this.producer.stop();
        await this.producer.disconnect();
        await this.consumer.disconnect();
        this.emit('disconnect');
        resolve(true);
      }
      catch(error) {
        this.emit('error', 'Error in CascadeService.connect: ' + error);
        reject(error);
      }
    });  
  }

  setRetryLevels(count: number, options?: {timeoutLimit?: number[], batchLimit: number[]}): Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        if(this.topicsArr.length > count){
          const diff = this.topicsArr.length - count;
          for(let i = 0; i < diff; i++){
            this.topicsArr.pop();
          };
        }
        else {
          for(let i = this.retries; i < count; i++){
            this.topicsArr.push(this.topic + '-cascade-retry-' + (i+1));
          }
        }

        this.producer.setRetryTopics(this.topicsArr, options);
        this.retries = count;
        

        // get an admin client to pre-register topics
        const admin = this.kafka.admin();
        await admin.connect();
        const registerTopics = {
          waitForLeaders: true,
          topics: [],
        }
        this.topicsArr.forEach(topic => registerTopics.topics.push({topic}));

        await admin.createTopics(registerTopics);
        const re = new RegExp(`^${this.topic}-cascade-retry-.*`);
        console.log('topics registered =', (await admin.listTopics()).filter(topic => topic === this.topic || topic.search(re) > -1));
        await admin.disconnect();

        setTimeout(() => {
          console.log('Registered topics with Kafka...');
          resolve(true);
        }, 10);
      }
      catch(error) {
        // console.log('Logged an error in the setRetryLevels:', error);
        this.emit('error', 'Error in CascadeService.setRetryLevels: ' + error);
        reject(error);
      }
    });
  }

  run():Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        const status = await this.consumer.run(this.serviceCB, 
          (msg) => { this.emit('success', msg); this.successCB(msg) }, 
          async (msg) => {
            try {
              await this.producer.send(msg);
            }
            catch(error) {
              console.log('test', 'Error in CascadeProducer.send:', error);
              // try {
              // this.emit('error', 'Error in CascadeProducer.send:', error);
              // } catch(error2) {}
            }
          });
        this.emit('run');
        resolve(status);
      } catch(error) {
        this.emit('error', 'Error in CascadeService.run: ' + error);
        reject(error);
      }
      
    });
  }

  stop():Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        await this.consumer.stop();
        await this.producer.stop();

        this.emit('stop');
        resolve(true);
      } catch (error) {
        this.emit('error', 'Error in CascadeService.stop: ' + error);
        reject(error);
      }

    });
  }

  async pause():Promise<any> {
    // check to see if service is already paused
    if (!this.producer.paused) {
      return new Promise (async (resolve, reject) => {
        try {
          await this.consumer.pause();
          this.producer.pause();
          this.emit('pause');
          resolve(true);
        } catch (error) {
          this.emit('error', 'Error in CascadeService.pause: ' + error);
          reject(error);
        }
      });
    } else {
      console.log('cascadeService.pause called while service is already paused!');
    }
  }

  paused() {
    // return producer.paused boolean;
    return this.producer.paused;
  }

  async resume(): Promise<any> {
    // check to see if service is paused
    if (this.producer.paused) {
      return new Promise(async (resolve, reject)=> {
        try{
          await this.consumer.resume();
          await this.producer.resume();
          this.emit('resume');
          resolve(true);
        } catch (error){
          this.emit('error', 'Error in CascadeService.resume: ' + error);
          reject(error);
        }
      });
    } else {
      console.log('cascadeService.resume called while service is already running!');
    }
  }

  on(event: string, callback: (arg: any) => any) {
    if(!this.events.includes(event)) throw new Error('Unknown event: ' + event);
    super.on(event, callback);
  }
}

export default CascadeService;