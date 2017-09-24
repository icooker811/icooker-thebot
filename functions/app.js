const functions = require('firebase-functions');

const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);

const 
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),  
  request = require('request');


var app = express();

const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ? 
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

const SERVER_URL = (process.env.SERVER_URL) ?
  (process.env.SERVER_URL) :
  config.get('serverURL');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}


app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);          
  }  
});


app.post('/webhook', function (req, res) {
  var data = req.body;

  if (data.object == 'page') {
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    res.sendStatus(200);
  }
});


var sicksenseSay = require('./data/example.json');
var questions = sicksenseSay['questions'];
var pages = {}
questions.forEach(function (question) {
  pages[question.id] = question;
});

var transitions = sicksenseSay['transitions'];
var symptoms = require('./data/symptoms.json');
var brain = require('./data/brain.json');
var sentences = {}
brain.forEach(function (word) {
  sentences[word.id] = word;
});


function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("Received message for user %d and page %d at %d with message:", 
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    return;
  } else if (quickReply) {
    findquickReplyNextPage(senderID, quickReply);
    return;
  }

  if (messageText) {
    findSymptomWord(senderID, messageText);
    return;
  }

  return;
}

function findquickReplyNextPage(senderID, quickReply){
  var quickReplyPayload = quickReply.payload;
  var informations = [];

  transitions.forEach(function (transition) {
    var checked = eval(transition.expression);
    if (checked) {
      var pageId = transition.to;
      var question = pages[pageId];
      if (question.id === pageId) {
        if (question.type === 'quickreply') {
          sendQuickReply(senderID, question);
          return;
        } else if (question.type === 'web_url'){
          var message = question;
          informations.push({
            title: message.text,
            subtitle: message.traser,
            item_url: message.item_url,
            image_url: SERVER_URL + '/assets/cough.jpg',
            buttons: [{
              type: "web_url",
              url: message.item_url,
              title: "More ..."
            }]
          });
        } else {
          sendTextMessage(senderID, question.text);
          return;
        }
      }
    }
  });

  if (informations.length > 0) {
    if (informations.length > 1) {
      sendTextMessage(senderID, 'อาจเกิดจาก ' + informations.length + ' อาการ');
    }
    // sendWebUrlMessage(senderID, informations);
    setTimeout(function() {
      var sym = 1;
      informations.forEach(function (information) {
        setTimeout(function() {
          var detail = information.subtitle;
          var count = 0;
          var splitCount = Math.ceil(detail.length / 500);
          for (var i = 1; i <= splitCount; i ++) {
            setTimeout(function() {
              var text = detail.substring(count, (count+500));
              if (count == 0) {
                text = information.title+ ": " + text;
              }
              sendTextMessage(senderID, text);
              count += 500;
            }, (i-1)*1000);
          }
          sym +=1;
        }, sym*2000);
      });

    }, 500);

    setTimeout(function() {
      sendRetry(senderID);
    }, 7000);
    return;
  }
  // sendTextMessage(senderID, "No idea....... Should go to see a doctor");
}

function findSymptomWord(recipientId, messageText) {
  messageText = messageText.toLowerCase();
  
  var search = [];
  var words = [];
  symptoms.forEach(function (symptom) {
    if (messageText.indexOf(symptom.text) !== -1) {
      var page = pages[symptom.page_id];
      search.push({
        "payload": symptom.page_id,
        "content_type":"text",
        "title": page.text
      });
      
      if (words.indexOf(symptom.text) === -1) {
        words.push(symptom.text);
      }
    }
  });
 
  if (search.length > 0) {
    search.push({
      "payload": 'RETRY',
      "content_type":"text",
      "title": 'ไม่ใช่'
    });

    var message = {
      text: 'เราพบ ' + (search.length-1) + ' รายการที่เกี่ยวข้อง',
      quick_replies: search
    };
    sendQuickReply(recipientId, message);
  } else {

    if (messageText.indexOf('help') !== -1 ||
        messageText.indexOf('ป่วย') !== -1 ||
        messageText.indexOf('ไม่สบาย') !== -1 
      ) {
      sendStart(recipientId);
      return;
    }

    var possibleMessages = [];
    brain.forEach(function (word) {
      var regex = eval(word.question);
      if (messageText.match(regex)) {
        var answer = eval(word.answer);
        possibleMessages.push(answer);
        sendTextMessage(recipientId, answer);
        return;
      }
    });
    if (possibleMessages.length > 0) {
      // Cut threshold
    } else {
      sendTextMessage(recipientId, 'ขอโทษนะ เรายังไม่เข้าใจคำถามของคุณ ลองพิมพ์ "help" หรือ "ป่วย" หรือ "ไม่สบาย" เราอาจจะช่วนคุณได้นะ :D');
    }
  }
}

function sendStart(recipientId) {
  var message = ''
  var startQuestionId = sicksenseSay['startQuestionId']
  var message = pages[startQuestionId];
  sendQuickReply(recipientId, message);
}

function sendRetry(recipientId) {
  var message = ''
  var retryQuestionId = sicksenseSay['retryQuestionId']
  var message = pages[retryQuestionId];
  sendQuickReply(recipientId, message);
}

function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText,
      metadata: "DEVELOPER_DEFINED_METADATA"
    }
  };

  callSendAPI(messageData);
}

function sendQuickReply(recipientId, message) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: message.text,
      quick_replies: message.quick_replies
    }
  };
  callSendAPI(messageData);
}

function sendWebUrlMessage(recipientId, elements) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements:  elements
        }
      }
    }
  };  

  callSendAPI(messageData);
}

function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s", 
          messageId, recipientId);
      } else {
      console.log("Successfully called Send API for recipient %s", 
        recipientId);
      }
    } else {
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });  
}


// module.exports = app;
exports.app = functions.https.onRequest(app);

