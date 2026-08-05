import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: env.isProduction ? "info" : "debug",
  ...(env.isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
      }),
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "*.passwordHash",
      "*.password",
      "*.accessToken",
    ],
    remove: true,
  },
});

export type Logger = typeof logger;
