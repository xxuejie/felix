const { v4: uuidv4 } = require("uuid");

class RedEnvelope {
  constructor(chat, payerId, payerUsername, args) {
    this.id = uuidv4();
    this.chat = chat;
    this.payerId = payerId;
    this.payerUsername = payerUsername;
    this.args = args;
    this.receivers = [];
  }

  toJSON() {
    return JSON.stringify({
      id: this.id,
      chat: this.chat,
      payerId: this.payerId,
      payerUsername: this.payerUsername,
      args: this.args,
      receivers: this.receivers,
    });
  }

  static fromJSON(data) {
    const parsed = JSON.parse(data);
    const e = new RedEnvelope(
      parsed.chat,
      parsed.payerId,
      parsed.payerUsername,
      parsed.args
    );
    e.id = parsed.id;
    e.receivers = parsed.receivers;
    return e;
  }

  num() {
    return this.args[0];
  }

  remaining() {
    return this.num() - this.receivers.length;
  }

  text(index) {
    return `#${index} - Sent to "${
      this.chat.title
    }" group, ${this.remaining()} remaining of ${this.num()}`;
  }

  async grab(receiverId, storage) {
    if (this.remaining() <= 0) {
      throw new Error("You are too late!");
    }
    if (this.receivers.find((receiver) => receiver.id === receiverId)) {
      throw new Error("You have already grabbed one!");
    }
    let address;
    try {
      address = (await storage.get(`address:${receiverId}`)).toString();
    } catch (e) {
      throw new Error("Please set your receiving address in the bot!");
    }
    this.receivers.push({
      id: receiverId,
      address,
    });
  }

  makeReply(reply, editMessage = null) {
    let message;
    if (this.receivers.length < this.args[0]) {
      reply.inlineKeyboard([
        [
          {
            text: "Grab",
            callback_data: JSON.stringify({
              t: "grab",
              i: this.id,
            }),
          },
        ],
      ]);
      message = `${this.payerUsername} sends a red envelope, remaining: ${
        this.args[0] - this.receivers.length
      }`;
    } else {
      message = `${this.payerUsername} sent a red envelope!`;
    }
    if (editMessage) {
      reply.editText(editMessage, message);
    } else {
      reply.text(message);
    }
  }

  complete(reply, txHash) {
    reply.text(
      `${this.payerUsername} has paid the red envelope! TX hash: ${txHash}`
    );
  }
}

module.exports = {
  RedEnvelope,
};
