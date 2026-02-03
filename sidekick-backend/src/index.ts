import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import { config } from './config';
import { prisma, disconnectPrisma } from './db/client';

// Import services
import { DirectionTranslator } from './services/DirectionTranslator';
import { PositionTracker } from './services/PositionTracker';
import { PathFinder } from './services/PathFinder';
import { TriggerEvaluator } from './services/TriggerEvaluator';
import { VisionClient } from './services/VisionClient';
import { SpeechGenerator } from './services/SpeechGenerator';
import { NavigationEngine } from './services/NavigationEngine';
import { SessionManager } from './websocket/SessionManager';

// Import route handlers
import authRoutes from './api/auth';
import flatRoutes from './api/flats';
import roomRoutes from './api/rooms';
import imageRoutes from './api/images';
import navigateRoutes from './api/navigate';
import { registerWebSocket } from './websocket/index';

/**
 * Create Fastify instance with logger
 */
const fastify = Fastify({
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    transport:
      config.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  },
});

/**
 * Authentication decorator
 * 
 * Verifies JWT token from Authorization header and attaches user to request.
 * Use with @fastify/auth or fastify.authenticate().
 */
async function setupAuthentication() {
  fastify.decorate('authenticate', async function (request: any, reply: any) {
    try {
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'Missing or invalid authorization header' });
      }

      const token = authHeader.substring(7);
      const decoded = (fastify as any).jwt.verify(token) as { id: string; email: string };

      // Attach user to request
      request.user = {
        id: decoded.id,
        email: decoded.email,
      };
    } catch (error) {
      return reply.code(401).send({ error: 'Invalid or expired token' });
    }
  });
}

/**
 * Register Fastify plugins
 */
async function registerPlugins() {
  // CORS - allow all origins in development
  await fastify.register(cors, {
    origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN,
    credentials: true,
  });

  // JWT Authentication
  await fastify.register(jwt, {
    secret: config.JWT_SECRET,
  });

  // Setup authentication decorator
  await setupAuthentication();

  // WebSocket support
  await fastify.register(websocket);
}

/**
 * Initialize all services
 */
function initializeServices() {
  console.log('[Server] Initializing services...');

  const directionTranslator = new DirectionTranslator();
  const positionTracker = new PositionTracker();
  const pathFinder = new PathFinder();
  const triggerEvaluator = new TriggerEvaluator();
  const visionClient = new VisionClient(config.VISION_API_URL);
  const speechGenerator = new SpeechGenerator(directionTranslator);
  const navigationEngine = new NavigationEngine(
    prisma,
    pathFinder,
    positionTracker,
    directionTranslator,
    triggerEvaluator,
    visionClient
  );
  const sessionManager = new SessionManager();

  console.log('[Server] Services initialized');

  return {
    directionTranslator,
    positionTracker,
    pathFinder,
    triggerEvaluator,
    visionClient,
    speechGenerator,
    navigationEngine,
    sessionManager,
  };
}

/**
 * Register REST API routes
 */
async function registerRoutes(_services: ReturnType<typeof initializeServices>) {
  // Health check endpoint
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });

  // API v1 routes
  const apiPrefix = '/api/v1';
  await fastify.register(authRoutes, { prefix: `${apiPrefix}/auth` });
  await fastify.register(flatRoutes, { prefix: `${apiPrefix}/flats` });
  await fastify.register(roomRoutes, {
    prefix: `${apiPrefix}/flats/:flatId/rooms`,
  });
  await fastify.register(imageRoutes, {
    prefix: `${apiPrefix}/flats/:flatId/rooms/:roomId/images`,
  });
  await fastify.register(navigateRoutes, { prefix: `${apiPrefix}/navigate` });

  console.log('[Server] Routes registered');
}

/**
 * Register WebSocket routes
 */
async function registerWebSocketRoutes(services: ReturnType<typeof initializeServices>) {
  await registerWebSocket(fastify, {
    navigationEngine: services.navigationEngine,
    sessionManager: services.sessionManager,
    fastify: fastify,
    directionTranslator: services.directionTranslator,
    triggerEvaluator: services.triggerEvaluator,
  } as any);
}

/**
 * Start the server
 */
async function start() {
  try {
    console.log('[Server] Starting SideKick Backend...');
    console.log('[Server] Environment:', config.NODE_ENV);
    console.log('[Server] Port:', config.PORT);

    // Register plugins
    await registerPlugins();

    // Initialize services
    const services = initializeServices();

    // Attach services to Fastify instance for route access
    (fastify as any).navigationEngine = services.navigationEngine;
    (fastify as any).directionTranslator = services.directionTranslator;
    (fastify as any).triggerEvaluator = services.triggerEvaluator;

    // Register routes
    await registerRoutes(services);

    // Register WebSocket
    await registerWebSocketRoutes(services);

    // Start server
    await fastify.listen({
      port: config.PORT,
      host: '0.0.0.0',
    });

    console.log('[Server] Listening on port:', config.PORT);
    console.log('[Server] Health check: http://localhost:' + config.PORT + '/health');
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown() {
  console.log('[Server] Shutting down gracefully...');

  try {
    // Close WebSocket connections
    // This will be handled by SessionManager when implemented

    // Close Fastify server
    await fastify.close();

    // Disconnect Prisma
    await disconnectPrisma();

    console.log('[Server] Shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('[Server] Error during shutdown:', error);
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Server] Uncaught exception:', error);
  shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled rejection at:', promise, 'reason:', reason);
  shutdown();
});

// Start the server
start();

// Export for testing or external use
export { prisma };
