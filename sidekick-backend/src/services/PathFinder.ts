import type { Room } from '../models/Room.js';
import type { Doorway } from '../models/Doorway.js';
import type { PathSegment, Checkpoint } from '../models/NavigationSession.js';

/**
 * Graph node structure for pathfinding
 */
interface GraphNode {
  room: Room;
  doorways: Doorway[];
}

/**
 * PathFinder Service
 * 
 * Calculates routes between rooms using Breadth-First Search (BFS) algorithm.
 * Converts room sequences into step-by-step navigation segments with checkpoints.
 */
export class PathFinder {
  /**
   * Finds the shortest path between two rooms and returns navigation segments
   * 
   * @param rooms - Array of all rooms in the flat
   * @param doorways - Array of all doorways connecting rooms
   * @param fromRoomId - Starting room ID
   * @param toRoomId - Destination room ID
   * @returns Array of PathSegment objects representing the navigation path
   * @throws Error if no path exists or rooms are not found
   * 
   * @example
   * const rooms = [{id: 'A', ...}, {id: 'B', ...}, {id: 'C', ...}];
   * const doorways = [{fromRoomId: 'A', toRoomId: 'B', ...}, {fromRoomId: 'B', toRoomId: 'C', ...}];
   * findPath(rooms, doorways, 'A', 'C')
   * // Returns: [segment A→B, segment B→C]
   * 
   * @example
   * // Same start and end room
   * findPath(rooms, doorways, 'A', 'A')
   * // Returns: [] (empty array)
   */
  findPath(
    rooms: Room[],
    doorways: Doorway[],
    fromRoomId: string,
    toRoomId: string
  ): PathSegment[] {
    // Edge case: same room
    if (fromRoomId === toRoomId) {
      return [];
    }

    // Build adjacency graph
    const graph = this.buildGraph(rooms, doorways);

    // Validate that both rooms exist
    if (!graph.has(fromRoomId)) {
      throw new Error(`Room not found: ${fromRoomId}`);
    }
    if (!graph.has(toRoomId)) {
      throw new Error(`Room not found: ${toRoomId}`);
    }

    // Find shortest path using BFS
    const roomSequence = this.bfs(graph, fromRoomId, toRoomId);

    if (!roomSequence) {
      throw new Error(`No path found from room ${fromRoomId} to room ${toRoomId}`);
    }

    // Convert room sequence to navigation segments
    return this.buildSegments(graph, doorways, roomSequence);
  }

  /**
   * Builds an adjacency graph from rooms and doorways
   * 
   * @param rooms - Array of all rooms
   * @param doorways - Array of all doorways
   * @returns Map where key is room ID and value contains room data and outgoing doorways
   * 
   * Note: Doorways are bidirectional - if A→B exists, we can also traverse B→A
   * (with reversed heading). This method includes both directions in the graph.
   */
  private buildGraph(
    rooms: Room[],
    doorways: Doorway[]
  ): Map<string, GraphNode> {
    const graph = new Map<string, GraphNode>();

    // Initialize all rooms in graph
    for (const room of rooms) {
      graph.set(room.id, {
        room,
        doorways: [],
      });
    }

    // Add doorways to graph (bidirectional)
    for (const doorway of doorways) {
      // Forward direction: fromRoomId → toRoomId
      const fromNode = graph.get(doorway.fromRoomId);
      if (fromNode) {
        fromNode.doorways.push(doorway);
      }

      // Reverse direction: toRoomId → fromRoomId (create reverse doorway)
      const toNode = graph.get(doorway.toRoomId);
      if (toNode) {
        // Create a reverse doorway with opposite heading
        const reverseDoorway: Doorway = {
          ...doorway,
          fromRoomId: doorway.toRoomId,
          toRoomId: doorway.fromRoomId,
          compassHeading: (doorway.compassHeading + 180) % 360, // Reverse direction
        };
        toNode.doorways.push(reverseDoorway);
      }
    }

    return graph;
  }

  /**
   * Breadth-First Search to find shortest path between two rooms
   * 
   * @param graph - Adjacency graph
   * @param startId - Starting room ID
   * @param endId - Target room ID
   * @returns Array of room IDs from start to end, or null if no path exists
   * 
   * @example
   * // Graph: A → B → C
   * bfs(graph, 'A', 'C')
   * // Returns: ['A', 'B', 'C']
   */
  private bfs(
    graph: Map<string, GraphNode>,
    startId: string,
    endId: string
  ): string[] | null {
    // Queue stores paths (arrays of room IDs)
    const queue: string[][] = [[startId]];
    const visited = new Set<string>([startId]);

    while (queue.length > 0) {
      const currentPath = queue.shift()!;
      const currentRoomId = currentPath[currentPath.length - 1];

      // Found destination
      if (currentRoomId === endId) {
        return currentPath;
      }

      // Explore neighbors
      const currentNode = graph.get(currentRoomId);
      if (!currentNode) {
        continue;
      }

      for (const doorway of currentNode.doorways) {
        const nextRoomId = doorway.toRoomId;

        // Skip if already visited
        if (visited.has(nextRoomId)) {
          continue;
        }

        // Mark as visited and add to queue
        visited.add(nextRoomId);
        queue.push([...currentPath, nextRoomId]);
      }
    }

    // No path found
    return null;
  }

  /**
   * Converts a room sequence into navigation segments
   * 
   * @param graph - Adjacency graph
   * @param doorways - All doorways (for finding specific doorway data)
   * @param roomSequence - Array of room IDs from start to end
   * @returns Array of PathSegment objects
   * 
   * @example
   * // Room sequence: ['A', 'B', 'C']
   * // Creates segments: walk to doorway in A, enter B, walk to doorway in B, enter C
   */
  private buildSegments(
    graph: Map<string, GraphNode>,
    doorways: Doorway[],
    roomSequence: string[]
  ): PathSegment[] {
    const segments: PathSegment[] = [];

    // For each consecutive pair of rooms
    for (let i = 0; i < roomSequence.length - 1; i++) {
      const fromRoomId = roomSequence[i];
      const toRoomId = roomSequence[i + 1];

      // Find the doorway connecting these rooms
      const doorway = this.findDoorway(doorways, fromRoomId, toRoomId);
      if (!doorway) {
        // Should not happen if graph is correct, but handle gracefully
        continue;
      }

      const fromRoom = graph.get(fromRoomId)?.room;
      const toRoom = graph.get(toRoomId)?.room;

      if (!fromRoom || !toRoom) {
        continue;
      }

      // Calculate distance to doorway within the fromRoom
      // Using Euclidean distance from room center (0,0) to doorway position
      const distanceToDoorway = Math.sqrt(
        doorway.positionX * doorway.positionX + doorway.positionY * doorway.positionY
      );

      // Calculate heading to doorway from room center
      const headingToDoorway = this.calculateHeadingToDoorway(doorway);

      // Segment 1: Walk to doorway within current room
      if (distanceToDoorway > 0.5) {
        // Only create walk segment if doorway is not at room center
        segments.push({
          index: segments.length,
          action: 'walk',
          fromRoomId,
          toRoomId: fromRoomId, // Still in same room
          compassHeading: headingToDoorway,
          distanceSteps: Math.round(distanceToDoorway),
          instruction: '', // Will be filled at runtime
          expectedLandmarks: [],
          checkpoints: this.generateCheckpoints(Math.round(distanceToDoorway), segments.length),
        });
      }

      // Segment 2: Exit/enter through doorway
      segments.push({
        index: segments.length,
        action: 'enter_room',
        fromRoomId,
        toRoomId,
        compassHeading: doorway.compassHeading,
        distanceSteps: doorway.distanceSteps,
        instruction: '', // Will be filled at runtime
        expectedLandmarks: [],
        checkpoints: this.generateCheckpoints(doorway.distanceSteps, segments.length),
      });
    }

    return segments;
  }

  /**
   * Finds a doorway connecting two rooms
   * 
   * @param doorways - Array of all doorways
   * @param fromRoomId - Source room ID
   * @param toRoomId - Target room ID
   * @returns Doorway object or null if not found
   */
  private findDoorway(
    doorways: Doorway[],
    fromRoomId: string,
    toRoomId: string
  ): Doorway | null {
    return (
      doorways.find(
        (d) => d.fromRoomId === fromRoomId && d.toRoomId === toRoomId
      ) || null
    );
  }

  /**
   * Calculates compass heading from room center to doorway position
   * 
   * @param doorway - Doorway object with positionX and positionY
   * @returns Compass heading in degrees (0-360)
   */
  private calculateHeadingToDoorway(doorway: Doorway): number {
    // Use atan2 to get angle, then convert to compass heading
    const radians = Math.atan2(doorway.positionY, doorway.positionX);
    let degrees = (radians * 180) / Math.PI;

    // Convert from math coordinates (0° = East) to compass (0° = North)
    degrees = 90 - degrees;

    // Normalize to 0-360 range
    if (degrees < 0) {
      degrees += 360;
    } else if (degrees >= 360) {
      degrees -= 360;
    }

    return degrees;
  }

  /**
   * Generates checkpoints for a navigation segment based on distance
   * 
   * @param distanceSteps - Total distance of the segment in steps
   * @param segmentIndex - Index of the segment in the path
   * @returns Array of Checkpoint objects
   * 
   * Rules:
   * - If distance > 20 steps: add "info" checkpoint at halfway
   * - If distance > 10 steps: add "warning" checkpoint 5 steps before end
   * - If distance > 30 steps: make the warning checkpoint require visual confirm
   * 
   * @example
   * generateCheckpoints(25, 0)
   * // Returns: [
   * //   {type: 'info', atStep: 12, ...},
   * //   {type: 'warning', atStep: 20, requiresVisualConfirm: false, ...}
   * // ]
   */
  private generateCheckpoints(
    distanceSteps: number,
    segmentIndex: number
  ): Checkpoint[] {
    const checkpoints: Checkpoint[] = [];
    const timestamp = Date.now();

    // Checkpoint at halfway point (if distance > 20 steps)
    if (distanceSteps > 20) {
      const halfwayStep = Math.floor(distanceSteps / 2);
      checkpoints.push({
        id: `cp_info_${segmentIndex}_${timestamp}_1`,
        atStep: halfwayStep,
        type: 'info',
        message: `You're about halfway through this segment`,
        requiresVisualConfirm: false,
      });
    }

    // Warning checkpoint 5 steps before end (if distance > 10 steps)
    if (distanceSteps > 10) {
      const warningStep = Math.max(1, distanceSteps - 5);
      const requiresConfirm = distanceSteps > 30;

      checkpoints.push({
        id: `cp_warning_${segmentIndex}_${timestamp}_2`,
        atStep: warningStep,
        type: requiresConfirm ? 'confirm' : 'warning',
        message: requiresConfirm
          ? `Approaching end of segment, visual confirmation recommended`
          : `Approaching end of segment`,
        requiresVisualConfirm: requiresConfirm,
      });
    }

    return checkpoints;
  }

  /**
   * Calculates total distance of a path in steps
   * 
   * @param path - Array of PathSegment objects
   * @returns Total distance in steps
   * 
   * @example
   * const path = [
   *   {distanceSteps: 10, ...},
   *   {distanceSteps: 5, ...},
   *   {distanceSteps: 15, ...}
   * ];
   * getTotalDistance(path)
   * // Returns: 30
   */
  getTotalDistance(path: PathSegment[]): number {
    return path.reduce((sum, segment) => sum + segment.distanceSteps, 0);
  }

  /**
   * Estimates total navigation time in seconds
   * 
   * @param path - Array of PathSegment objects
   * @returns Estimated time in seconds (rounded)
   * 
   * Assumes average walking speed of ~0.8 seconds per step.
   * 
   * @example
   * const path = [{distanceSteps: 50, ...}];
   * getEstimatedTime(path)
   * // Returns: Math.round(50 * 0.8) = 40 seconds
   */
  getEstimatedTime(path: PathSegment[]): number {
    const totalDistance = this.getTotalDistance(path);
    return Math.round(totalDistance * 0.8);
  }
}
