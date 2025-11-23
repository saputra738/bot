const axios = require("axios");
require("dotenv").config();

async function askAI(prompt) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.MODEL || "gpt-4o-mini",
        messages: [
          { role: "system", content: "Kamu adalah asisten AI yang membantu user." },
          { role: "user", content: prompt }
        ]
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.data.choices[0].message.content;

  } catch (err) {
    console.log("AI ERROR:", err.response?.data || err.message);
    return "❌ AI Error: " + (err.response?.data?.error?.message || err.message);
  }
}

module.exports = { askAI };
