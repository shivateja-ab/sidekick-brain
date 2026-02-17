import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const flatId = '9ae7bd7f-279b-4e11-8082-45da53429a03';

    const flat = await prisma.flatMap.findUnique({
        where: { id: flatId },
        include: {
            rooms: {
                include: {
                    doorways: true,
                    incomingDoorways: true
                }
            },
        }
    });

    if (!flat) {
        console.log('Flat not found');
        return;
    }

    console.log(`=== FLATMAP: ${flat.name} ===`);
    console.log(`ID: ${flat.id}`);

    console.log('\n--- ROOMS ---');
    flat.rooms.forEach(r => {
        console.log(`[${r.id}] ${r.name} (${r.type})`);
    });

    console.log('\n--- DOORWAYS (Segments) ---');
    for (const room of flat.rooms) {
        for (const d of room.doorways) {
            const toRoom = flat.rooms.find(r => r.id === d.toRoomId);
            console.log(`FROM: ${room.name} [${room.id.substring(0, 8)}]`);
            console.log(`  TO: ${toRoom ? toRoom.name : 'Unknown'} [${d.toRoomId.substring(0, 8)}]`);
            console.log(`  HEADING: ${d.compassHeading}° | STEPS: ${d.distanceSteps} | TYPE: ${d.type}`);
            console.log('-------------------');
        }
    }
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
