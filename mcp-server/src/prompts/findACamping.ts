import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** Prompt guidé `find_a_camping` (§7.2). */
export function registerFindACamping(server: McpServer): void {
  server.registerPrompt(
    'find_a_camping',
    {
      title: 'Find a Yelloh! Village campsite',
      description: 'Starts a guided campsite search from the user’s dates, number of people and wishes.',
      argsSchema: {
        dates: z.string().optional().describe('Desired dates, free text'),
        people: z.string().optional().describe('Number of people'),
        wishes: z.string().optional().describe('Wishes, free text (comfort, sea, pool…)'),
        place: z.string().optional().describe('Desired place, free text (region, country, city…)'),
      },
    },
    (args) => {
      const known = [
        args.dates ? `- Dates: ${args.dates}` : '- Dates: not given yet',
        args.people ? `- Number of people: ${args.people}` : '- Number of people: not given yet',
        args.wishes ? `- Wishes: ${args.wishes}` : '- Wishes: none given',
        args.place ? `- Place: ${args.place}` : '- Place: anywhere',
      ].join('\n');
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `I am looking for a Yelloh! Village campsite.\n${known}\n\nPlease ask me for any missing dates or number of people first. Then call get_search_filters to map my wishes to filter ids${args.place ? ' and search_geography to find the campsites of my place' : ''}, call search_campings, and present each proposal with its campsite page link and its booking link. Do not state prices. Answer in my language.`,
            },
          },
        ],
      };
    },
  );
}
