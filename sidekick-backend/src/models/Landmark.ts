export interface Landmark {
  id: string;
  roomId: string;
  name: string;
  description: string | null;
  positionX: number;
  positionY: number;
  compassDirection: number | null;
}

export interface LandmarkWithRelations extends Landmark {
  room?: Room;
}

// Helper type for creating landmarks
export interface CreateLandmarkInput {
  roomId: string;
  name: string;
  description?: string;
  positionX: number;
  positionY: number;
  compassDirection?: number;
}

// Helper type for updating landmarks
export interface UpdateLandmarkInput {
  name?: string;
  description?: string;
  positionX?: number;
  positionY?: number;
  compassDirection?: number;
}

// Import types that will be defined in other files
import type { Room } from './Room';
