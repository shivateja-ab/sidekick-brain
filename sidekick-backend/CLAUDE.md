# SideKick — Indoor Navigation for Visually Impaired Users

## What This Project Is

SideKick guides visually impaired users through indoor spaces (apartments, offices) using voice instructions, step counting, compass heading, and camera-based position verification via Gemini Vision API. A sighted helper maps the route once by physically walking it; blind users replay that route with turn-by-turn spoken guidance.

## Monorepo Structure

```
sidekick-brain/
├── sidekick-backend/    # Fastify + Prisma + WebSocket server (TypeScript)
├── sidekick-mobile/     # React Native + Expo mobile app (TypeScript)
└── SideKick/            # Vercel Edge Functions — Gemini Vision API proxy
```

## Architecture & Data Flow

### Mapping Phase (setup, done once by sighted helper)
1. Mobile creates flat → rooms → guided route mapping (walk the route, mark waypoints)
2. Each doorway gets: compass heading, step count, doorway type (door/archway/opening)
3. Reference photos captured at waypoints → uploaded to backend → Gemini `extract_features` generates description + landmarks
4. Backend stores everything in SQLite via Prisma

### Navigation Phase (runtime, used by blind user)
1. User picks start room + destination → mobile sends `start_navigation` via WebSocket
2. Backend `NavigationEngine.startNavigation()` loads flat map, calls `PathFinder.findPath()` which replays the recorded doorway chain (no graph search — the mapped route IS the path)
3. Backend sends path + first instruction to mobile
4. Mobile starts sensors (pedometer + compass), streams `sensor_update` messages via WebSocket every 500ms
5. Backend counts steps, checks segment completion. At segment boundaries (`advanceSegment`):
   - If waypoint has reference images → sends `request_visual` to mobile
   - Mobile captures photo → sends `visual_response` with base64 image
   - Backend forwards to Vercel Edge → Gemini compares current vs reference image → returns `isOnTrack`, `confidence`, `speech`
   - Backend sends combined `visual_result` with doorway action + next direction + room name
   - If no reference images → sends next turn instruction directly
6. At destination: builds arrival speech with room features, spatial orientation, doorway context

### Speech Pattern
Instructions are descriptive and contextual:
- Walking: "Walk straight ahead, about 12 steps toward Kitchen. Open the door and go through."
- Waypoint confirmed: "Verified. Open the door and go through. Walk on your right, about 20 steps to Trashroom."
- Arrival: "Confirmed. Trashroom is on your left through the door, I can see trash bin. You have successfully reached Trashroom. Navigation complete."

## Component Responsibilities

### sidekick-backend (`src/`)
| File | Role |
|------|------|
| `services/NavigationEngine.ts` | **Core orchestrator.** Manages sessions, processes sensor updates, calls Vision API, generates instructions, handles arrival. The largest and most complex file. |
| `services/PathFinder.ts` | Follows recorded doorway chain from start to destination. No BFS/Dijkstra — the guided-mapped route IS the path. |
| `services/DirectionTranslator.ts` | Converts compass headings to clock positions ("on your right") and generates natural language instructions with doorway/room context. |
| `services/PositionTracker.ts` | Dead reckoning: step counting + compass heading → position estimate. Manages confidence decay. |
| `services/TriggerEvaluator.ts` | Decides when to request visual confirmation. Currently disabled for proactive triggers — only fires at waypoints. |
| `services/VisionClient.ts` | HTTP client wrapping calls to the Vercel Edge Gemini proxy. |
| `services/SpeechGenerator.ts` | Utility for building speech strings. |
| `websocket/handlers.ts` | Routes WebSocket messages to NavigationEngine methods. |
| `websocket/SessionManager.ts` | Tracks connected clients, maps client IDs to session IDs. |
| `api/rooms.ts` | REST CRUD for rooms, doorways, landmarks. Doorway creation is **upsert** (re-mapping same connection updates instead of 409). Auto-creates reverse doorway. |
| `api/images.ts` | Reference image upload + optional Gemini feature extraction. |
| `api/auth.ts` | JWT auth (register/login/me). |
| `api/flats.ts` | Flat map CRUD. |

### sidekick-mobile (`src/`)
| File | Role |
|------|------|
| `services/NavigationController.ts` | **Mobile orchestrator.** Manages navigation lifecycle, sensor updates, visual capture, speech. Bridges WebSocket messages to UI state. |
| `services/websocket.ts` | WebSocket singleton. Sends/receives typed messages. Auto-reconnect with backoff. |
| `services/sensors.ts` | Pedometer + compass fusion. Batches step counts with headings. |
| `services/speech.ts` | TTS wrapper with priority queue (urgent interrupts normal). |
| `services/cameraCapture.ts` | Camera capture + JPEG compression via expo-image-manipulator. |
| `stores/navigationStore.ts` | Zustand store — phase, instruction, confidence, heading, visual requests. |
| `stores/mappingStore.ts` | Zustand store — flat/room/doorway/landmark/image CRUD with backend sync. |
| `screens/mapping/GuidedRouteMappingScreen.tsx` | Walk-the-route mapper. Records legs between rooms, supports reusing existing rooms as shared waypoints. |
| `components/VisualConfirmOverlay.tsx` | Camera overlay for waypoint verification. Auto-capture when aligned. Silent countdown (no spoken numbers). |
| `components/NavigationHUD.tsx` | Direction arrow + step counters + instruction text + action buttons. No map (removed). |

### SideKick (Vercel Edge — `api/v1/analyze/`)
| File | Role |
|------|------|
| `vision.js` | Structured JSON endpoint. Two-image comparison (`validate_position`), single-image analysis (`identify_room`, `check_obstacles`, `extract_features`). Uses `gemini-2.5-flash`. Has retry with exponential backoff for rate limits. |
| `stream.js` | SSE streaming endpoint for scene descriptions. Uses `gemini-2.5-flash-lite` (15 RPM free tier). Has retry with exponential backoff. |

## Key Design Decisions

**Step counting over cosine projection:** Indoor compass is too noisy for heading-projected distance. Every step counts as 1 step of progress. Simpler, more reliable.

**Guided mapping = the path:** No graph algorithms. The user physically walks the route during setup, and navigation replays that exact chain. PathFinder just follows doorways from A→B→C.

**Shared waypoints:** When mapping multiple routes (bedroom→kitchen, bedroom→bathroom), the user can reuse an existing room (e.g., hallway junction) as a waypoint. This connects the route graph so PathFinder can navigate between any two rooms, not just pre-walked pairs.

**Doorway upsert:** Re-mapping the same A→B connection updates heading/steps instead of failing with 409. Allows iterative refinement.

**Combined speech at waypoints:** After visual confirmation, everything is spoken as ONE message ("Verified. Open the door. Walk 20 steps to Kitchen.") instead of separate visual_result + instruction to avoid repetition and speech cutoff.

**Gemini heuristic overrides:** Gemini sometimes returns `isOnTrack: false` but speech like "position confirmed." The backend parses speech sentiment and overrides the boolean when confidence > 0.7 and keywords match.

**Reference images stay in DB as base64:** Not ideal for production (should be object storage), but works for the current SQLite + single-server setup.

## Environment Setup

### Backend
```bash
cd sidekick-backend
cp .env.example .env  # Set VISION_API_URL, JWT_SECRET, DATABASE_URL
npx prisma migrate dev
npm run dev            # Starts on port 3000
```

Required env vars:
- `VISION_API_URL` — Vercel deployment URL (e.g., `https://sidekick-sable.vercel.app/api/v1/analyze/vision`)
- `JWT_SECRET` — Any string for dev, must be strong in production
- `DATABASE_URL` — `file:./dev.db` for SQLite
- `PORT` — Default 3000

### Mobile
```bash
cd sidekick-mobile
npm install
# Update DEV_API_URL in src/config.ts to your machine's local IP
npx expo start
```

The mobile app connects to backend via REST (`http://<IP>:3000/api/v1/`) and WebSocket (`ws://<IP>:3000/ws`). Phone must be on the same WiFi as the dev machine.

### Vercel Edge (Gemini proxy)
```bash
cd SideKick
vercel --prod
```

Required Vercel env vars:
- `GEMINI_API_KEY` — Google AI Studio API key
- `GEMINI_MODEL` (optional) — Overrides default model for both endpoints
- `GEMINI_VISION_MODEL` (optional) — Override for vision.js only (default: `gemini-2.5-flash`)
- `GEMINI_STREAM_MODEL` (optional) — Override for stream.js only (default: `gemini-2.5-flash-lite`)

## Database Schema (Prisma/SQLite)

Core models: `User`, `FlatMap`, `Room`, `Doorway`, `Landmark`, `ReferenceImage`, `NavigationSession`.

- `Doorway` always exists in pairs (forward + reverse, auto-created by backend)
- `ReferenceImage.imageData` is base64 JPEG stored directly in SQLite
- `NavigationSession.pathJson` is the serialized PathSegment array
- Session status flow: `initializing → navigating → awaiting_visual → navigating → ... → completed`

## WebSocket Message Types

### Client → Server
`start_navigation`, `sensor_update`, `visual_response`, `visual_skipped`, `voice_command`, `pause_navigation`, `resume_navigation`, `cancel_navigation`, `request_repeat`, `ping`, `position_report`, `heading_report`

### Server → Client
`navigation_started`, `instruction`, `request_visual`, `visual_result`, `position_update`, `navigation_complete`, `navigation_cancelled`, `recalculating`, `error`, `pong`, `route_update`, `hazard_warning`, `arrival`

## Common Pitfalls

- **"No route found"**: The start room has no forward doorway chain to the destination. Check that guided mapping completed fully and doorways exist in the DB. Enable `[PathFinder]` logs to see the connection graph.
- **Rate limit 429 from Gemini**: Both vision.js and stream.js have retry with backoff. If persistent, check your API tier in Google AI Studio. Free tier is 5-15 RPM. Tier 1 (billing enabled) gives 150-300 RPM.
- **Stale JWT on app start**: Expected — the app tries the stored token, gets 401, clears it, shows login screen. Not a bug.
- **Session not found after reconnect**: NavigationEngine keeps sessions in memory. If the backend restarts mid-navigation, the session is lost from memory (still in DB but not auto-reloaded for active navigation).
- **Double speech**: If two messages arrive back-to-back (visual_result + instruction), both try to speak. The pattern is to put all speech in ONE message and send the other with empty speech.

## Future Roadmap

- On-device vision models (MobileCLIP for image comparison, SmolVLM for captioning) — eliminates cloud latency
- Real-time obstacle detection (YOLO11-nano at 25+ FPS) with voice alerts
- On-device Whisper for voice commands without network dependency
- PostgreSQL + object storage for production (replace SQLite + base64 blobs)
- Session recovery after backend restart
- Outdoor navigation (currently mock data in handlers.ts)
