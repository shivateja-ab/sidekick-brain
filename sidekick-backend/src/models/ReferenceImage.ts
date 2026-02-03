export interface ReferenceImage {
  id: string;
  roomId: string;
  locationTag: string;
  compassHeading: number;
  imageData: string; // base64 encoded image
  description: string | null;
  detectedLandmarks: string | null; // JSON array of strings
  capturedAt: Date;
}

export interface ReferenceImageWithRelations extends ReferenceImage {
  room?: Room;
}

// Helper type for creating reference images
export interface CreateReferenceImageInput {
  roomId: string;
  locationTag: string;
  compassHeading: number;
  imageData: string; // base64 encoded
  description?: string;
  detectedLandmarks?: string[]; // Will be converted to JSON string
}

// Helper type for updating reference images
export interface UpdateReferenceImageInput {
  locationTag?: string;
  compassHeading?: number;
  imageData?: string;
  description?: string;
  detectedLandmarks?: string[];
}

// Import types that will be defined in other files
import type { Room } from './Room';
