export type DoorwayType = 'door' | 'archway' | 'opening';

export interface Doorway {
  id: string;
  fromRoomId: string;
  toRoomId: string;
  positionX: number;
  positionY: number;
  compassHeading: number;
  type: string; // DoorwayType as string
  distanceSteps: number;
}

export interface DoorwayWithRelations extends Doorway {
  fromRoom?: Room;
  toRoom?: Room;
}

// Helper type for creating doorways
export interface CreateDoorwayInput {
  fromRoomId: string;
  toRoomId: string;
  positionX: number;
  positionY: number;
  compassHeading: number;
  type?: DoorwayType | string;
  distanceSteps?: number;
}

// Helper type for updating doorways
export interface UpdateDoorwayInput {
  positionX?: number;
  positionY?: number;
  compassHeading?: number;
  type?: DoorwayType | string;
  distanceSteps?: number;
}

// Import types that will be defined in other files
import type { Room } from './Room.js';
