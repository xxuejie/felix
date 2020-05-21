const botgram = require("botgram");
const { RPC } = require("ckb-js-toolkit");
const { secp256k1Blake160 } = require("@ckb-lumos/common-scripts");
const { transfer, payFee, prepareSigningEntries } = secp256k1Blake160;
const { Indexer } = require("@ckb-lumos/indexer");
const {
  configs,
  generateAddress,
  parseAddress,
  TransactionSkeleton,
  createTransactionFromSkeleton,
  sealTransaction,
} = require("@ckb-lumos/helpers");
const { OrderedMap } = require("immutable");
const { v4: uuidv4 } = require("uuid");

const SHANNONS = BigInt(100000000);

const CKB_CONFIG =
  process.env.CKB_MAINNET === "true" ? configs.LINA : configs.AGGRON4;
const CKB_RPC_URI = process.env.CKB_RPC_URI || "http://127.0.0.1:8114";
const CKB_INDEXER_DATA = process.env.CKB_INDEXER_DATA || "./indexer-data";
const indexer = new Indexer(CKB_RPC_URI, CKB_INDEXER_DATA);
indexer.startForever();
const rpc = new RPC(CKB_RPC_URI);

/* In memory for now, will change later */
const sessions = {};
function loadSession(id) {
  sessions[id] = sessions[id] || {};
  return sessions[id];
}

const options = {};
const proxy =
  process.env.TG_PROXY || process.env.ALL_PROXY || process.env.HTTPS_PROXY;
if (proxy) {
  const HttpsProxyAgent = require("https-proxy-agent");
  options.agent = new HttpsProxyAgent(proxy);
}
const bot = botgram(process.env.BOT_TOKEN, options);

const DATA_RECEIVING_ADDRESS = "receiving_address";
const DATA_PAY = "pay";
const DATA_PAY_AMOUNT = "pay_amount";
const DATA_PAY_ADDRESS = "pay_address";
const DATA_PAY_SIGNING = "pay_signing";

class RedEnvelope {
  constructor(chat, payerId, payerUsername, args) {
    this.id = uuidv4();
    this.chat = chat;
    this.payerId = payerId;
    this.payerUsername = payerUsername;
    this.args = args;
    this.receivers = [];
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

  grab(receiverId) {
    if (this.remaining() <= 0) {
      throw new Error("You are too late!");
    }
    if (this.receivers.find((receiver) => receiver.id === receiverId)) {
      throw new Error("You have already grabbed one!");
    }
    const session = loadSession(receiverId);
    const address = session[DATA_RECEIVING_ADDRESS];
    if (!address) {
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

let allEnvelopes = OrderedMap();

function userEnvelopes(payerId) {
  return allEnvelopes
    .filter((e) => e.payerId === payerId)
    .valueSeq()
    .toArray();
}

bot.command("start", (_msg, reply) => {
  reply.text("Greetings!");
});
bot.command("help", (_msg, reply) => {
  reply.text(
    "/set_receiving_address - Set receiving address\n" +
      "/receiving_address - Get receiving address\n" +
      "/pending_envelopes - List of pending envelopes sent by me\n" +
      "/pay - Pay an envelope"
  );
});
bot.command("set_receiving_address", (msg, reply) => {
  if (msg.chat.type !== "user") {
    /* Ignore non-private request */
    return;
  }
  loadSession(msg.from.id).state = DATA_RECEIVING_ADDRESS;
  reply.text("Please enter your receiving address:");
});
bot.command("receiving_address", (msg, reply) => {
  const address = loadSession(msg.from.id)[DATA_RECEIVING_ADDRESS];
  if (address) {
    reply.text(`Your receiving address is: ${address}`);
  } else {
    reply.text("You haven't set a receiving address!");
  }
});
bot.command("pending_envelopes", (msg, reply) => {
  if (msg.chat.type !== "user") {
    /* Ignore non-private request */
    return;
  }
  const myEnvelopes = userEnvelopes(msg.from.id);
  if (myEnvelopes.length === 0) {
    reply.text("No pending envelopes!");
    return;
  }
  reply.text(myEnvelopes.map((envelope, i) => envelope.text(i)).join("\n"));
});
bot.command("pay", (msg, reply) => {
  if (msg.chat.type !== "user") {
    /* Ignore non-private request */
    return;
  }
  const myEnvelopes = userEnvelopes(msg.from.id);
  if (myEnvelopes.length === 0) {
    reply.text("No pending envelopes!");
    return;
  }
  loadSession(msg.from.id).state = DATA_PAY;
  let texts = myEnvelopes.map((envelope, i) => envelope.text(i)).join("\n");
  reply
    .keyboard(
      myEnvelopes.map((_envelope, i) => [`#${i}`]),
      true
    )
    .text(`${texts}\n\nPlease select the envelope to pay:`);
});
bot.command("send", (msg, reply) => {
  if (msg.chat.type !== "group") {
    reply.text("You can only send a red envelope to a group!");
    return;
  }
  const username = msg.from.username ? `@${msg.from.username}` : "Someone";
  const args = msg.args(2);
  bot.getChatMembersCount(msg.chat, (err, count) => {
    if (err) {
      console.log(`Get member count error: ${err}`);
      return;
    }
    if (args.length === 0) {
      args.push(Math.floor(Math.random() * count) + 1);
    }
    const envelope = new RedEnvelope(msg.chat, msg.from.id, username, args);
    allEnvelopes = allEnvelopes.set(envelope.id, envelope);
    envelope.makeReply(reply);
  });
});
bot.command("download_transaction", (msg, reply) => {
  const txSkeleton = loadSession(msg.from.id)[DATA_PAY_ADDRESS];
  if (!txSkeleton) {
    reply.text("No tranaction is generated!");
  } else {
    const data = Buffer.from(
      JSON.stringify({
        tx: createTransactionFromSkeleton(txSkeleton),
        signingInfos: txSkeleton.get("signingEntries").toArray(),
        inputs: txSkeleton.get("inputs").toArray(),
      })
    );
    reply.document(data, "signing_tx.json");
  }
});

const STATE_MACHINE = {
  [DATA_RECEIVING_ADDRESS]: async (session, msg, reply) => {
    const address = msg.text || "";
    try {
      parseAddress(address, { config: CKB_CONFIG });
    } catch (e) {
      console.log(`Error parsing address: ${e}`);
      reply.text(
        `Please use a valid CKB address that starts with ${CKB_CONFIG.PREFIX}!`
      );
      return DATA_RECEIVING_ADDRESS;
    }
    session[DATA_RECEIVING_ADDRESS] = address;
    reply.text(`Setting your receiving address to ${address}!`);
    return null;
  },
  [DATA_PAY]: async (session, msg, reply) => {
    const index = parseInt((msg.text || "").substr(1));
    const myEnvelopes = userEnvelopes(msg.from.id);
    const envelope = myEnvelopes[index];
    if (!envelope) {
      reply.text("Specified envelope does not exist!");
      return null;
    }
    if (envelope.remaining() === envelope.num()) {
      reply.text("No one has grabbed the red packet!");
      return DATA_PAY_AMOUNT;
    }
    session[DATA_PAY] = envelope;
    reply.text("Please enter the CKBytes to pay for the red envelope:");
    return DATA_PAY_AMOUNT;
  },
  [DATA_PAY_AMOUNT]: async (session, msg, reply) => {
    const envelope = session[DATA_PAY];
    let amount;
    try {
      amount = BigInt(msg.text || "0") * SHANNONS;
    } catch (e) {
      reply.text("Please enter a valid amount!");
      return DATA_PAY_AMOUNT;
    }
    if (
      amount <
      (BigInt(61) * SHANNONS + BigInt(1)) * BigInt(envelope.receivers.length)
    ) {
      reply.text("The specified amount is not enough for the red envelope!");
      return DATA_PAY_AMOUNT;
    }
    session[DATA_PAY_AMOUNT] = amount;
    reply.text("Please enter the address used to pay for the red envelope:");
    return DATA_PAY_ADDRESS;
  },
  [DATA_PAY_ADDRESS]: async (session, msg, reply) => {
    const envelope = session[DATA_PAY];
    const amount = session[DATA_PAY_AMOUNT];
    const fromAddress = msg.text;
    const count = envelope.receivers.length;
    let remainingAmount = amount - BigInt(count) * BigInt(61) * SHANNONS;
    /* Assemble transaction here */
    let txSkeleton = TransactionSkeleton({ cellProvider: indexer });
    for (let i = 0; i < count; i++) {
      const receiver = envelope.receivers[i];
      let currentAmount;
      if (i === count - 1) {
        currentAmount = remainingAmount;
      } else {
        const leftCount = BigInt(count - i - 1);
        const max = (remainingAmount * BigInt(2)) / leftCount;
        currentAmount = BigInt(Math.floor(Math.random() * Number(max)));
        if (remainingAmount - currentAmount < leftCount) {
          currentAmount = remainingAmount - leftCount;
        }
      }
      remainingAmount -= currentAmount;
      txSkeleton = await transfer(
        txSkeleton,
        fromAddress,
        receiver.address,
        currentAmount + BigInt(61) * SHANNONS,
        { config: CKB_CONFIG }
      );
    }
    /*
     * TODO: for now we always set 1 CKB as transaction fee, will deal with this
     * later.
     */
    txSkeleton = await payFee(txSkeleton, fromAddress, SHANNONS, {
      config: CKB_CONFIG,
    });
    txSkeleton = prepareSigningEntries(txSkeleton, { config: CKB_CONFIG });
    session[DATA_PAY_ADDRESS] = txSkeleton;
    const signingInfos = txSkeleton
      .get("signingEntries")
      .map((e) => {
        const lock = txSkeleton.get("inputs").get(e.index).cell_output.lock;
        const address = generateAddress(lock, { config: CKB_CONFIG });
        return `Address: ${address}\nMessage: ${e.message}`;
      })
      .toArray()
      .join("\n");
    reply.text(
      `Please sign the following messages required by the transaction:\n\n${signingInfos}\n\nSignatures must be in hex string format with 0x prefix, each different signature should occupy its own line.\n/download_transaction to verify the generated messages yourself.`
    );
    return DATA_PAY_SIGNING;
  },
  [DATA_PAY_SIGNING]: async (session, msg, reply) => {
    const envelope = session[DATA_PAY];
    const amount = session[DATA_PAY_AMOUNT];
    const txSkeleton = session[DATA_PAY_ADDRESS];
    const signatures = (msg.text || "").split("\n");
    let tx;
    try {
      tx = sealTransaction(txSkeleton, signatures);
    } catch (e) {
      console.log(`Error sealing transaction: ${e} stack: ${e.stack}`);
      reply.text("Invalid signatures!");
      return DATA_PAY_SIGNING;
    }
    const txHash = await rpc.send_transaction(tx);
    reply.text(`Envelope successfully paid! TX hash: ${txHash}`);
    delete session[DATA_PAY];
    delete session[DATA_PAY_AMOUNT];
    delete session[DATA_PAY_ADDRESS];
    const chatReply = bot.reply(envelope.chat);
    envelope.complete(chatReply, txHash);
    return null;
  },
};

async function processStateMachine(msgOrQuery, reply) {
  const session = loadSession(msgOrQuery.from.id);
  const state = session.state;
  delete session.state;
  let next_state = null;
  if (state && STATE_MACHINE[state]) {
    next_state = await STATE_MACHINE[state](session, msgOrQuery, reply);
  } else {
    reply.text("Huh? /help to see all commands");
  }
  if (next_state) {
    session.state = next_state;
  }
}

bot.callback((query, next) => {
  let data;
  try {
    data = JSON.parse(query.data);
  } catch (e) {
    console.log(`Invalid callback data: ${e}`);
    next();
  }
  if (!query.message) {
    reply.text(`@${query.from.username} The envelope has expired!`);
    return;
  }
  const reply = bot.reply(query.message.chat);
  if (data.t === "grab") {
    const envelope = allEnvelopes.get(data.i);
    if (!envelope) {
      console.log(`Invalid red envelope ID: ${data.i}`);
      return;
    }
    try {
      envelope.grab(query.from.id);
      envelope.makeReply(reply, query.message);
    } catch (e) {
      reply.text(`@${query.from.username} ${e.message}`);
    }
    return;
  }
  processStateMachine(query, reply).catch((e) => {
    console.log(`Error occurs: ${e} stack: ${e.stack}`);
    reply.text("Ooops, unexpected errors");
  });
});

bot.text((msg, reply) => {
  processStateMachine(msg, reply).catch((e) => {
    console.log(`Error occurs: ${e} stack: ${e.stack}`);
    reply.text("Ooops, unexpected errors");
  });
});
