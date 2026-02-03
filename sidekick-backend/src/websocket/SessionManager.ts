import type { ServerMessage } from '../services/NavigationEngine';

/**
 * WebSocket connection type
 * Compatible with @fastify/websocket and standard WebSocket implementations
 */
type WebSocketConnection = {
  send(data: string | Buffer): void;
  readyState: number;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
};

/**
 * Connected client information
 */
export interface ConnectedClient {
  id: string; // Unique connection ID
  socket: WebSocketConnection; // The WebSocket instance
  userId: string; // Authenticated user ID
  sessionId: string | null; // Active navigation session ID (if any)
  connectedAt: Date;
  lastPingAt: Date;
}

/**
 * SessionManager Service
 * 
 * Tracks WebSocket connections and maps them to user IDs and navigation sessions.
 * Handles cleanup when connections close and provides utilities for message broadcasting.
 * 
 * Uses singleton pattern - one instance manages all connections.
 * 
 * @example
 * const manager = new SessionManager();
 * const clientId = manager.addClient(socket, 'user-123');
 * manager.setActiveSession(clientId, 'session-456');
 * manager.broadcast(message, (client) => client.userId === 'user-123');
 */
export class SessionManager {
  // Map of clientId → ConnectedClient
  private clients: Map<string, ConnectedClient> = new Map();

  // Map of userId → clientId (for quick lookup)
  private userToClient: Map<string, string> = new Map();

  // Counter for generating unique client IDs
  private clientIdCounter = 0;

  /**
   * Creates a new SessionManager instance
   */
  constructor() {
    // Initialize empty maps
    this.clients = new Map();
    this.userToClient = new Map();
    this.clientIdCounter = 0;
  }

  /**
   * Adds a new client connection
   * 
   * If the user already has an active connection, the old one is disconnected.
   * 
   * @param socket - WebSocket connection
   * @param userId - Authenticated user ID
   * @returns Unique client ID
   * 
   * @example
   * const clientId = manager.addClient(socket, 'user-123');
   * console.log(`Client connected: ${clientId}`);
   */
  addClient(socket: WebSocketConnection, userId: string): string {
    // Generate unique client ID
    const clientId = `client_${Date.now()}_${++this.clientIdCounter}`;

    // Disconnect existing client for this user if any
    const existingClientId = this.userToClient.get(userId);
    if (existingClientId) {
      const existingClient = this.clients.get(existingClientId);
      if (existingClient) {
        console.log(
          `[SessionManager] Disconnecting existing client ${existingClientId} for user ${userId}`
        );
        this.removeClient(existingClientId);
      }
    }

    // Create new client object
    const now = new Date();
    const client: ConnectedClient = {
      id: clientId,
      socket,
      userId,
      sessionId: null,
      connectedAt: now,
      lastPingAt: now,
    };

    // Store in maps
    this.clients.set(clientId, client);
    this.userToClient.set(userId, clientId);

    console.log(`[SessionManager] Client added: ${clientId} for user ${userId}`);

    return clientId;
  }

  /**
   * Removes a client connection
   * 
   * If the client has an active session, it's marked as disconnected
   * but the session itself is not deleted (handled by NavigationEngine).
   * 
   * @param clientId - Client ID to remove
   * 
   * @example
   * manager.removeClient('client-123');
   */
  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      console.warn(`[SessionManager] Attempted to remove non-existent client: ${clientId}`);
      return;
    }

    // If has active session, log it (don't delete session - NavigationEngine handles that)
    if (client.sessionId) {
      console.log(
        `[SessionManager] Client ${clientId} disconnected with active session: ${client.sessionId}`
      );
    }

    // Remove from maps
    this.clients.delete(clientId);
    this.userToClient.delete(client.userId);

    console.log(`[SessionManager] Client removed: ${clientId}`);
  }

  /**
   * Gets client by user ID
   * 
   * @param userId - User ID to lookup
   * @returns ConnectedClient or null if not found
   * 
   * @example
   * const client = manager.getClientByUserId('user-123');
   * if (client) {
   *   client.socket.send(JSON.stringify(message));
   * }
   */
  getClientByUserId(userId: string): ConnectedClient | null {
    const clientId = this.userToClient.get(userId);
    if (!clientId) {
      return null;
    }

    return this.clients.get(clientId) || null;
  }

  /**
   * Gets client by client ID
   * 
   * @param clientId - Client ID to lookup
   * @returns ConnectedClient or null if not found
   * 
   * @example
   * const client = manager.getClientById('client-123');
   * if (client) {
   *   console.log(`User: ${client.userId}, Session: ${client.sessionId}`);
   * }
   */
  getClientById(clientId: string): ConnectedClient | null {
    return this.clients.get(clientId) || null;
  }

  /**
   * Sets the active navigation session for a client
   * 
   * @param clientId - Client ID
   * @param sessionId - Navigation session ID
   * 
   * @example
   * manager.setActiveSession('client-123', 'session-456');
   */
  setActiveSession(clientId: string, sessionId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      console.warn(`[SessionManager] Attempted to set session for non-existent client: ${clientId}`);
      return;
    }

    client.sessionId = sessionId;
    console.log(`[SessionManager] Client ${clientId} active session set to: ${sessionId}`);
  }

  /**
   * Clears the active navigation session for a client
   * 
   * @param clientId - Client ID
   * 
   * @example
   * manager.clearActiveSession('client-123');
   */
  clearActiveSession(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      console.warn(
        `[SessionManager] Attempted to clear session for non-existent client: ${clientId}`
      );
      return;
    }

    const oldSessionId = client.sessionId;
    client.sessionId = null;
    console.log(`[SessionManager] Client ${clientId} active session cleared (was: ${oldSessionId})`);
  }

  /**
   * Updates the last ping timestamp for a client
   * 
   * Used to track connection health and detect stale connections.
   * 
   * @param clientId - Client ID
   * 
   * @example
   * // Called on each ping/pong
   * manager.updatePing('client-123');
   */
  updatePing(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    client.lastPingAt = new Date();
  }

  /**
   * Gets clients that haven't pinged recently
   * 
   * Used for cleanup of dead connections that didn't properly close.
   * 
   * @param maxAgeMs - Maximum age in milliseconds since last ping
   * @returns Array of stale clients
   * 
   * @example
   * // Find clients that haven't pinged in 60 seconds
   * const stale = manager.getStaleClients(60000);
   * stale.forEach(client => {
   *   console.log(`Stale client: ${client.id}`);
   *   manager.removeClient(client.id);
   * });
   */
  getStaleClients(maxAgeMs: number): ConnectedClient[] {
    const now = Date.now();
    const stale: ConnectedClient[] = [];

    for (const client of this.clients.values()) {
      const age = now - client.lastPingAt.getTime();
      if (age > maxAgeMs) {
        stale.push(client);
      }
    }

    return stale;
  }

  /**
   * Broadcasts a message to all clients (or filtered subset)
   * 
   * @param message - ServerMessage to send
   * @param filter - Optional filter function to select which clients receive the message
   * 
   * @example
   * // Broadcast to all clients
   * manager.broadcast(message);
   * 
   * @example
   * // Broadcast to specific user
   * manager.broadcast(message, (client) => client.userId === 'user-123');
   * 
   * @example
   * // Broadcast to clients with active sessions
   * manager.broadcast(message, (client) => client.sessionId !== null);
   */
  broadcast(message: ServerMessage, filter?: (client: ConnectedClient) => boolean): void {
    const messageStr = JSON.stringify(message);
    let sentCount = 0;
    let errorCount = 0;

    for (const client of this.clients.values()) {
      // Apply filter if provided
      if (filter && !filter(client)) {
        continue;
      }

      // Check if socket is still open
      // WebSocket readyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED
      if (client.socket.readyState !== 1) {
        // Socket is not open, skip
        continue;
      }

      try {
        client.socket.send(messageStr);
        sentCount++;
      } catch (error) {
        errorCount++;
        console.error(`[SessionManager] Error sending message to client ${client.id}:`, error);
        // Optionally remove client on send error
        // this.removeClient(client.id);
      }
    }

    if (sentCount > 0 || errorCount > 0) {
      console.log(
        `[SessionManager] Broadcast: sent=${sentCount}, errors=${errorCount}, type=${message.type}`
      );
    }
  }

  /**
   * Sends a message to a specific client
   * 
   * @param clientId - Client ID to send to
   * @param message - ServerMessage to send
   * @returns true if sent successfully, false otherwise
   * 
   * @example
   * const sent = manager.sendToClient('client-123', message);
   * if (!sent) {
   *   console.log('Failed to send message');
   * }
   */
  sendToClient(clientId: string, message: ServerMessage): boolean {
    const client = this.clients.get(clientId);
    if (!client) {
      console.warn(`[SessionManager] Attempted to send to non-existent client: ${clientId}`);
      return false;
    }

    // Check if socket is open
    if (client.socket.readyState !== 1) {
      console.warn(`[SessionManager] Socket not open for client: ${clientId}`);
      return false;
    }

    try {
      client.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error(`[SessionManager] Error sending message to client ${clientId}:`, error);
      return false;
    }
  }

  /**
   * Gets all active clients
   * 
   * @returns Array of all connected clients
   * 
   * @example
   * const clients = manager.getAllClients();
   * console.log(`Total clients: ${clients.length}`);
   */
  getAllClients(): ConnectedClient[] {
    const clients: ConnectedClient[] = [];
    for (const client of this.clients.values()) {
      clients.push(client);
    }
    return clients;
  }

  /**
   * Gets count of active clients
   * 
   * @returns Number of connected clients
   * 
   * @example
   * const count = manager.getClientCount();
   * console.log(`Active connections: ${count}`);
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Clears all clients (for testing or shutdown)
   * 
   * @example
   * manager.clearAll();
   */
  clearAll(): void {
    this.clients.clear();
    this.userToClient.clear();
    console.log('[SessionManager] All clients cleared');
  }
}
