import type { SensorUpdatePayload, VisualResponsePayload } from '../services/NavigationEngine';
// import type { ConnectedClient } from './SessionManager';

/**
 * Client message types sent from mobile app
 */
export type ClientMessage =
  | {
      type: 'start_navigation';
      payload: {
        flatMapId: string;
        destinationRoomId: string;
        currentRoomId?: string;
        currentHeading?: number;
      };
    }
  | {
      type: 'sensor_update';
      payload: SensorUpdatePayload;
    }
  | {
      type: 'visual_response';
      payload: VisualResponsePayload;
    }
  | {
      type: 'visual_skipped';
      payload?: {
        reason?: string;
      };
    }
  | {
      type: 'voice_command';
      payload: {
        command: string;
      };
    }
  | {
      type: 'pause_navigation';
      payload?: Record<string, never>;
    }
  | {
      type: 'resume_navigation';
      payload?: Record<string, never>;
    }
  | {
      type: 'cancel_navigation';
      payload?: Record<string, never>;
    }
  | {
      type: 'request_repeat';
      payload?: Record<string, never>;
    }
  | {
      type: 'ping';
      payload?: Record<string, never>;
    };

/**
 * Services container for WebSocket handlers
 */
export interface WebSocketServices {
  navigationEngine: any; // NavigationEngine
  sessionManager: any; // SessionManager
  fastify: any; // FastifyInstance
  
}
