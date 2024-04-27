import { createDeepgramConnection } from "./deepgram.js";
import { createElevenLabsConnection } from "./elevenlabs.js";
import { chat } from "./openai.js";
import { getLLMCost, getTTSCost, getTranscriptionCost } from "./pricing.js";
import prettyms from "pretty-ms";
import fs from "fs";

import WebSocket, { WebSocketServer } from "ws";

const deepgramMessages = [];
const chatHistory = [];
const inputAudioBuffers = [];
const outputAudioChunks = [];

const wss = new WebSocketServer({ port: Number(process.env.PORT ?? 3000) });

wss.on("connection", (ws) => {
  console.log("[WSS] Client connected to server.");

  const startTimestamp = Date.now();

  const deepgram = createDeepgramConnection();

  const elevenlabs = createElevenLabsConnection({ output_format: "pcm_16000" });

  const isDeepgramOpen = () => deepgram.readyState === WebSocket.OPEN;
  const isElevenLabsOpen = () => elevenlabs.readyState === WebSocket.OPEN;

  deepgram.addEventListener("message", async (messageEvent) => {
    const data = JSON.parse(messageEvent.data);

    deepgramMessages.push(data);

    if (data.type !== "Results") {
      return;
    }

    if (!data.is_final) {
      return; // we don't care about interim results
    }

    const transcript = data.channel.alternatives[0].transcript;

    if (!transcript) {
      return; // we don't care about empty transcripts
    }

    if (!isElevenLabsOpen()) {
      return; // we can't send anything to elevenlabs if we're not connected yet
    }

    console.log("[DEEPGRAM 🎥] T:", transcript);

    const message = await chat(transcript, chatHistory);

    chatHistory.push({
      prompt: transcript,
      message,
    });

    console.log("[OPENAI] LLM response:", message.content);

    // console.log("[ELVENLABS] sending text", resp);
    elevenlabs.send(
      JSON.stringify({
        text: message.content + " ",
        flush: true,
      }),
    );
  });

  elevenlabs.addEventListener("message", (messageEvent) => {
    const data = JSON.parse(messageEvent.data);

    if (data.audio) {
      console.log(
        "[ELEVENLABS] Recieved audio chunk:",
        data.audio.slice(0, 15) + "...",
      );

      const buf = Buffer.from(data.audio, "base64");

      outputAudioChunks.push(buf);

      ws.send(buf);
    }
  });

  ws.on("message", (message) => {
    inputAudioBuffers.push(message);

    if (isDeepgramOpen()) {
      console.log("[DEEPGRAM 🎥] Sending audio chunk to Deepgram.");
      deepgram.send(message);
    }
  });

  // ws.on("pong", heartbeat);
  ws.on("close", () => {
    deepgram.close();

    const duration = Date.now() - startTimestamp;

    console.log("[DEEPGRAM 🎥] Duration:", prettyms(duration));

    elevenlabs.close();

    const tmpFolder = `./tmp/${startTimestamp}`;

    // TODO: save audio chunks

    // if (chunks.length > 0) {
    //   await Bun.write(
    //     `${tmpFolder}/audio.mp3`,
    //     new Blob(chunks, { type: "audio/mp3" }),
    //   ).catch(console.error);
    // }

    // await Bun.write(
    //   `${tmpFolder}/input-audio.pcm`,
    //   new Blob(inputAudioBuffers),
    // );

    const saveJson = (filename, data) =>
      fs.writeFileSync(
        `${tmpFolder}/${filename}.json`,
        JSON.stringify(data, null, 2),
      );

    saveJson("deepgram", deepgramMessages);
    saveJson("chat-history", chatHistory);

    const metadata = {
      duration: prettyms(duration),
      startDate: new Date(startTimestamp),
      endDate: new Date(endTimestamp),

      durationMs: duration,
      startTimestamp,
      endTimestamp,
    };

    saveJson("metadata", metadata);

    const transcriptionCost = getTranscriptionCost(duration);
    const llmCost = chatHistory.reduce(
      (a, { prompt, message }) => a + getLLMCost(prompt, message.content ?? ""),
      0,
    );
    const ttsCost = chatHistory.reduce(
      (a, { message }) => a + getTTSCost(message.content ?? ""),
      0,
    );

    const totalCost = transcriptionCost + llmCost + ttsCost;

    const cost = {
      transcription: transcriptionCost,
      llm: llmCost,
      tts: ttsCost,

      total: totalCost,
      totalPretty: "$" + totalCost.toFixed(3),
    };

    saveJson("cost", cost);

    console.log("[WSS] Connection closed.");
  });
});