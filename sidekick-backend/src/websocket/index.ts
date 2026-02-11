import type { FastifyInstance } from 'fastify';
import type { ConnectedClient } from './SessionManager.js';
import type { ClientMessage, WebSocketServices } from './types.js';
import { handleMessage, sendMessagesToClient } from './handlers.js';

/**
 * Register WebSocket routes
 * 
 * @param fastify - Fastify instance
 * @param services - Service dependencies
 */
export async function registerWebSocket(
  fastify: FastifyInstance,
  services: WebSocketServices
): Promise<void> {
  fastify.get(
    '/ws',
    { websocket: true },
    (connection: any, request: any) => {
      let client: ConnectedClient | null = null;

      // Handle connection (WebSocket is already open at this point)
      (async () => {
        try {
          // Extract token from query string
          const token = request.query?.token || request.query?.t;

          if (!token) {
            console.log('[WS] Connection rejected: no token');
            connection.send(
              JSON.stringify({
                type: 'error',
                sessionId: undefined,
                timestamp: Date.now(),
                payload: {
                  code: 'authentication_required',
                  message: 'Authentication token required',
                  speech: 'Please provide an authentication token.',
                  recoverable: false,
                },
              })
            );
            connection.close(1008, 'Authentication required');
            return;
          }

          // Verify JWT token
          try {
            const decoded = (fastify as any).jwt.verify(token) as { userId: string; email: string };

            const clientId = services.sessionManager.addClient(connection, decoded.userId);
            client = services.sessionManager.getClientById(clientId);

            console.log(`[WS] Client connected: userId=${decoded.userId}, clientId=${clientId}`);

            // Send connection confirmation (matching mobile app expectations)
            connection.send(
              JSON.stringify({
                type: 'connected',
                sessionId: undefined,
                timestamp: Date.now(),
                payload: {
                  clientId: clientId,
                  timestamp: Date.now(),
                },
              })
            );
          } catch (jwtError: any) {
            console.log('[WS] Connection rejected: invalid token');
            connection.send(
              JSON.stringify({
                type: 'error',
                sessionId: undefined,
                timestamp: Date.now(),
                payload: {
                  code: 'authentication_failed',
                  message: 'Invalid or expired token',
                  speech: 'Authentication failed. Please reconnect with a valid token.',
                  recoverable: false,
                },
              })
            );
            connection.close(1008, 'Authentication failed');
          }
        } catch (error) {
          console.error('[WS] Connection error:', error);
          connection.close(1011, 'Internal server error');
        }
      })();

      // Handle incoming messages
      connection.on('message', async (message: Buffer) => {
        try {
          if (!client) {
            connection.send(
              JSON.stringify({
                type: 'error',
                sessionId: undefined,
                timestamp: Date.now(),
                payload: {
                  code: 'not_authenticated',
                  message: 'Not authenticated',
                  speech: 'Please authenticate first.',
                  recoverable: false,
                },
              })
            );
            return;
          }

          // Parse JSON message
          let parsedMessage: ClientMessage;
          try {
            const messageStr = message.toString();
            parsedMessage = JSON.parse(messageStr);
          } catch (parseError) {
            console.error('[WS] Invalid JSON message:', parseError);
            connection.send(
              JSON.stringify({
                type: 'error',
                sessionId: undefined,
                timestamp: Date.now(),
                payload: {
                  code: 'invalid_message',
                  message: 'Invalid JSON format',
                  speech: 'Invalid message format.',
                  recoverable: true,
                },
              })
            );
            return;
          }

          // Validate message has type
          if (!parsedMessage.type) {
            connection.send(
              JSON.stringify({
                type: 'error',
                sessionId: undefined,
                timestamp: Date.now(),
                payload: {
                  code: 'invalid_message',
                  message: 'Message must have a type field',
                  speech: 'Invalid message format.',
                  recoverable: true,
                },
              })
            );
            return;
          }

          console.log(`[WS] Message received: type=${parsedMessage.type}, clientId=${client.id}`);

          // Route to appropriate handler
          const responseMessages = await handleMessage(client, parsedMessage, services);

          // Send response messages
          if (responseMessages && responseMessages.length > 0) {
            sendMessagesToClient(connection, responseMessages);
          }
        } catch (error: any) {
          console.error('[WS] Message handling error:', error);
          connection.send(
            JSON.stringify({
              type: 'error',
              sessionId: client?.sessionId || undefined,
              timestamp: Date.now(),
              payload: {
                code: 'handler_error',
                message: error.message || 'Failed to process message',
                speech: 'An error occurred processing your request.',
                recoverable: true,
              },
            })
          );
        }
      });

      // Handle connection close
      connection.on('close', (code: number, _reason: Buffer) => {
        if (client) {
          console.log(
            `[WS] Client disconnected: userId=${client.userId}, clientId=${client.id}, code=${code}`
          );

          // If active navigation session, pause it (don't delete)
          if (client.sessionId) {
            console.log(`[WS] Pausing navigation session: ${client.sessionId}`);
            // Note: NavigationEngine will handle session cleanup on timeout
            // We just remove the client from SessionManager
          }

          // Remove client from SessionManager
          services.sessionManager.removeClient(client.id);
        } else {
          console.log(`[WS] Unauthenticated connection closed: code=${code}`);
        }
      });

      // Handle connection error
      connection.on('error', (error: Error) => {
        console.error('[WS] Connection error:', error);
        if (client) {
          services.sessionManager.removeClient(client.id);
        }
      });
    }
  );

  // Setup heartbeat/cleanup interval
  setInterval(() => {
    try {
      const staleClients = services.sessionManager.getStaleClients(60000); // 60 seconds

      for (const staleClient of staleClients) {
        console.log(`[WS] Disconnecting stale client: ${staleClient.id}`);
        try {
          staleClient.socket.close(1000, 'Connection timeout');
        } catch (error) {
          // Ignore errors when closing
        }
        services.sessionManager.removeClient(staleClient.id);
      }
    } catch (error) {
      console.error('[WS] Cleanup interval error:', error);
    }
  }, 30000); // Run every 30 seconds

  console.log('[WS] WebSocket routes registered');
}
