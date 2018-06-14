import * as amqp from "amqplib";
import { EventEmitter } from "events";
import * as winston from "winston";
import { IMessage, IMessageSender } from "./messages";

class RabbitmqSender implements IMessageSender {

    private events = new EventEmitter();
    private rabbitmqConnectionString: string;
    private messageQueueName: string;
    private channel: amqp.Channel;

    constructor(rabbitmqConfig: any, tmzConfig: any) {
        this.rabbitmqConnectionString = rabbitmqConfig.connectionString;
        this.messageQueueName = tmzConfig.messageQueueName;
    }

    public async initialize() {
        const connection = await amqp.connect(this.rabbitmqConnectionString);
        this.channel = await connection.createChannel();
        await this.channel.assertQueue(this.messageQueueName, { durable: true });
        winston.info(`Rabbitmq channel ready!`);

        connection.on("error", (error) => {
            this.events.emit("error", error);
        });
    }

    public send(message: IMessage) {
        this.channel.sendToQueue(this.messageQueueName, new Buffer(JSON.stringify(message)), { persistent: true });
    }

    public on(event: string, listener: (...args: any[]) => void): this {
        this.events.on(event, listener);
        return this;
    }
}

// Factory to switch between different message sender.
export function createMessageSender(rabbitmqConfig: any, tmzConfig: any): IMessageSender {
    return new RabbitmqSender(rabbitmqConfig, tmzConfig);
}
