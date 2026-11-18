import { handleTeamsRequest } from "@/server/teams/endpoint";

export const dynamic = "force-dynamic";

/** Microsoft Teams' calls to the bot (see server/teams/endpoint): signed with the Bot Framework's keys. */
export async function POST(request: Request) {
  return handleTeamsRequest(request);
}
