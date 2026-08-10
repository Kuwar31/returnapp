import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { apiRouter } from "./routes.js";

export const createApp = () => {
  const app = express();

  // Behind a load balancer this makes req.ip the real client address, which
  // the rate limiter keys on.
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
    }),
  );
  // Shopify webhook signatures are computed over the raw bytes, so that one
  // route parses its own body and must skip the global JSON parser.
  const jsonParser = express.json({ limit: "1mb" });
  app.use((req, res, next) => {
    if (req.path === "/api/shopify/webhooks") return next();
    jsonParser(req, res, next);
  });
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      // Health checks would otherwise flood the log.
      autoLogging: { ignore: (req) => req.url === "/api/health" },
    }),
  );

  app.use("/api", apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
