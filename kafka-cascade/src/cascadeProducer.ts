const { Kafka } = require('kafkajs');
import * as Types from './kafkaInterface';

// cascadeProducer
  // attempts retries on messages
    // increase retryCount on message
    // sets topic to next retry topic
    // send to DLQ when out of retry levels

class CascadeProducer {
  producer: Types.ProducerInterface;
  dlqCB: Types.RouteCallback;
  retryTopics: string[];

  // pass in kafka interface
  constructor(kafka: Types.KafkaInterface, dlqCB: Types.RouteCallback) {
    this.dlqCB = dlqCB;
    this.retryTopics = [];
    this.producer = kafka.producer();
  }

  connect(): Promise<any> {
    return this.producer.connect();
  }

  disconnect(): Promise<any> {
    return this.producer.disconnect();
  }

  /**
   * kafkaMessage = {
   *    topic: string,
   *    partition: number,
   *    messages: [{
   *      key: string,
   *      value: string,
   *      headers: {
   *        cascadeMetadata: {
    *        status: string,
    *        retries: int,
    *        topicArr: [],
    *       }
   *      }
   *    }]
   * }
   */

  send(msg: Types.KafkaConsumerMessageInterface): Promise<any> {
    try{
      // access cascadeMetadata - only first message for now, refactor later
      const metadata = JSON.parse(msg.message.headers.cascadeMetadata);
      // check if retries exceeds allowed number of retries
      if (metadata.retries < this.retryTopics.length) {
        msg.topic = this.retryTopics[metadata.retries];
        metadata.retries += 1;
        // populate producerMessage object
        const producerMessage = {
          topic: msg.topic, 
          messages: [{
            key: msg.message.key, 
            value: msg.message.value, 
            headers: { ...msg.message.headers, cascadeMetadata: JSON.stringify(metadata) }
          }]
        };
        
        return new Promise((resolve, reject) => {
          this.producer.send(producerMessage)
            .then(res => resolve(res))
            .catch(res => {
              console.log('Caught an error trying to send: ' + res);
              reject(res);
            });
        });
      } else {
        this.dlqCB(msg);
        return new Promise((resolve) => resolve(true));
      }
    }
    catch(error) {
      console.log('Caught error in CascadeProducer.send: ' + error);
    }
  }

  setRetryTopics(topicsArr: string[]) {
    this.retryTopics = topicsArr;    
  }
}

export default CascadeProducer;