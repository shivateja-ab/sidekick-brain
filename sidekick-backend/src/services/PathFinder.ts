import type { Room } from '../models/Room.js';
import type { Doorway } from '../models/Doorway.js';
import type { PathSegment } from '../models/NavigationSession.js';

/**
 * Room with optional landmark and reference image data for richer instructions
 */
interface RoomWithContext extends Room {
  landmarks?: Array<{ name: string; description: string | null }>;
  referenceImages?: Array<{ description: string | null; detectedLandmarks: string | null }>;
}

/**
 * PathFinder Service
 *
 * During guided mapping the user physically walks the route:
 *   Start → WP1 → WP2 → … → Destination
 * Each leg is saved as a doorway with compassHeading + distanceSteps.
 *
 * Navigation simply **replays that recorded chain** in order.
 * No graph construction, no BFS — the mapped route IS the path.
 */
export class PathFinder {
  /**
   * Builds the navigation path by following the recorded doorway chain
   * from `fromRoomId` to `toRoomId`.
   *
   * Algorithm:
   *   1. Index all forward doorways by their fromRoomId.
   *   2. Starting at fromRoomId, follow the chain: pick the doorway
   *      whose fromRoomId matches the current room, advance to its toRoomId.
   *   3. Stop when we reach toRoomId (success) or can't continue (error).
   *
   * This works because guided mapping creates a linear chain of doorways.
   */
  findPath(
    rooms: (Room & { landmarks?: any[]; referenceImages?: any[] })[],
    doorways: Doorway[],
    fromRoomId: string,
    toRoomId: string
  ): PathSegment[] {
    if (fromRoomId === toRoomId) {
      return [];
    }

    // Build a room lookup for landmark extraction
    const roomMap = new Map<string, RoomWithContext>();
    for (const room of rooms) {
      roomMap.set(room.id, room as RoomWithContext);
    }

    // Index forward doorways by fromRoomId.
    // A room may have multiple outgoing doorways (e.g. corridor with branches),
    // but for a guided-mapped linear route there is typically one per room
    // in the forward direction.
    const outgoing = new Map<string, Doorway[]>();
    for (const d of doorways) {
      const list = outgoing.get(d.fromRoomId) || [];
      list.push(d);
      outgoing.set(d.fromRoomId, list);
    }

    // Follow the chain from start to destination
    const segments: PathSegment[] = [];
    const visited = new Set<string>();
    let currentRoomId = fromRoomId;

    while (currentRoomId !== toRoomId) {
      if (visited.has(currentRoomId)) {
        throw new Error(
          `Circular route detected at room ${currentRoomId}. ` +
          `Cannot find path from ${fromRoomId} to ${toRoomId}.`
        );
      }
      visited.add(currentRoomId);

      const candidates = outgoing.get(currentRoomId) || [];

      // Try to find a doorway that leads closer to the destination.
      // Prefer a doorway whose toRoomId we haven't visited yet.
      let doorway: Doorway | undefined;

      // First: direct link to destination
      doorway = candidates.find(d => d.toRoomId === toRoomId);

      // Second: any unvisited next room
      if (!doorway) {
        doorway = candidates.find(d => !visited.has(d.toRoomId));
      }

      if (!doorway) {
        throw new Error(
          `No route from room ${currentRoomId} toward ${toRoomId}. ` +
          `Make sure the route was fully mapped with guided mapping.`
        );
      }

      const toRoom = roomMap.get(doorway.toRoomId);
      const landmarks = this.extractLandmarks(toRoom);
      const isLast = doorway.toRoomId === toRoomId;

      segments.push({
        index: segments.length,
        action: isLast ? 'enter_room' : 'walk',
        fromRoomId: currentRoomId,
        toRoomId: doorway.toRoomId,
        compassHeading: doorway.compassHeading,
        distanceSteps: doorway.distanceSteps,
        doorwayType: doorway.type,
        instruction: '',
        expectedLandmarks: landmarks,
        checkpoints: [],
      });

      currentRoomId = doorway.toRoomId;
    }

    if (segments.length === 0) {
      throw new Error(`No doorways found from ${fromRoomId} to ${toRoomId}`);
    }

    return segments;
  }

  /**
   * Extracts landmark names from a room's landmarks and reference image data
   */
  private extractLandmarks(room: RoomWithContext | undefined): string[] {
    if (!room) return [];
    const names: string[] = [];

    if (room.landmarks) {
      for (const lm of room.landmarks) {
        if (lm.name) names.push(lm.name);
      }
    }

    if (room.referenceImages) {
      for (const img of room.referenceImages) {
        if (img.detectedLandmarks) {
          try {
            const parsed = typeof img.detectedLandmarks === 'string'
              ? JSON.parse(img.detectedLandmarks)
              : img.detectedLandmarks;
            if (Array.isArray(parsed)) {
              names.push(...parsed.filter((s: any) => typeof s === 'string'));
            }
          } catch { /* ignore parse errors */ }
        }
        if (img.description && !names.length) {
          names.push(img.description);
        }
      }
    }

    return [...new Set(names)].slice(0, 5);
  }

  getTotalDistance(path: PathSegment[]): number {
    return path.reduce((sum, seg) => sum + seg.distanceSteps, 0);
  }

  getEstimatedTime(path: PathSegment[]): number {
    return Math.round(this.getTotalDistance(path) * 0.8);
  }
}
