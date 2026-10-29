// JSON schemas the model sees (DESIGN.md Tools). The descriptions are load-bearing: day-1 check 2 failed without them.
// Every turn must call a tool (tool_choice required); reply is the direct answer. Implementations live in agent.ts.
const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } })

const ref = { type: 'string', description: "A place ref from the context like 'p2', or 'destination'" }

export const TOOLS = [
  fn('reply', 'Answer the user directly, briefly, in their language style. Use when no other tool is needed or after tools return.',
    { text: { type: 'string' } }, ['text']),
  fn('find_stops', 'Find real places along the current route.', {
    need: {
      type: 'string',
      description: "1-3 plain English words a person would type into Google Maps, e.g. 'momos', 'pizza', " +
        "'vegetarian restaurant', 'ATM'. For sights and history use '<city> history landmarks'. Never a brand name; " +
        "put a brand in similar_to. Keep the user's breadth: 'religious places' stays 'religious places', never one " +
        "religion or kind ('temples').",
    },
    similar_to: { type: 'string', description: 'Optional place or brand name to match (same brand first)' },
    places: {
      type: 'array', items: { type: 'string' }, maxItems: 4,
      description: 'Optional specific places to look up by name: ones the user named, or well-known sites that match ' +
        "the topic (e.g. for 26/11: 'Taj Mahal Palace Hotel', 'Leopold Cafe'). Each is checked on Google; unknown names are dropped.",
    },
    limit_type: {
      type: 'string',
      enum: ['from_now', 'detour', 'near_destination'],
      description: "from_now = stop must be reachable within limit_min minutes from now ('within 20 min', " +
        "'jaldi'). detour = stop may be anywhere on the route but adds at most limit_min extra minutes " +
        "('max 10 min extra'). near_destination = places within limit_min drive of the destination (things to " +
        "see or do there, 'near where we are going', 'wahan paas'). No limit given: urgent needs (food now, washroom, fuel, " +
        "repair, hospital) -> from_now 15; sights, shopping, things to do -> near_destination 15.",
    },
    limit_min: { type: 'integer', description: 'Minutes: from now, extra detour, or from the destination' },
    notes: { type: 'string', description: 'Free text for ranking only (who, mood, diet, budget, minimum rating). Never place names: those go in places.' },
    save: { type: 'string', description: "Optional: a diet, allergy, health or mobility fact about the people said in this request " +
      "('Dad is vegetarian', 'Mom is allergic to seafood'), kept for this trip. Never interests, wishes or this trip's plans. " +
      'Leave out if the context notes or profile already have it.' },
  }, ['need', 'limit_type', 'limit_min']),
  fn('place_details', 'Opening hours, phone number, address and price level for one shown result.', { ref }, ['ref']),
  fn('eta_from_here', "Drive time with traffic from the car's position to a shown result, a planned stop or the destination (the minutes " +
    "the trip bar shows). With from 'destination': from where the trip ends to that place, for 'how far is X from the gallery / from there'.", {
    ref,
    depart_at: { type: 'string', description: 'Optional later departure time, ISO 8601 with +05:30' },
    from: { type: 'string', enum: ['destination'], description: "Only for a place-to-destination question: measure from the destination, not the car" },
  }, ['ref']),
  fn('web_search', "Web search for what map data can't answer: is it famous or worth it, what people say, menu, parking. Not for finding stops.",
    { query: { type: 'string' } }, ['query']),
  fn('make_link', 'Links to open a shown result in Google Maps or Uber, plus a WhatsApp share text.', { ref }, ['ref']),
  fn('remember', 'Save a fact the user states about a person (diet, allergy, health, dislikes) or who is on this ride. Inside a search request use find_stops save instead.', {
    note: { type: 'string' },
    scope: { type: 'string', enum: ['trip', 'profile'], description: "trip (default) = for this trip only; profile = kept for every trip, only when the " +
      "user asks for that ('always', 'every trip', 'remember for next time', 'permanently')" },
  }, ['note', 'scope']),
  fn('forget', 'Delete a saved note by its id (ids are shown in context notes and profile).', { note_id: { type: 'string' } }, ['note_id']),
  // No notes section: notes and profile are in the context with ids, and reading them again was a wasted step.
  fn('get_trip_state', 'Read detail left out of the context: every turn ahead, earlier searches, or older messages. Not for notes, profile or the plan: they are in the context.', {
    section: { type: 'string', enum: ['steps', 'searches', 'older_messages'] },
  }, ['section']),
  // C (ride 2026-10-18): "I have reached hotel lets end here" got "Trip ended safely!" with the trip still open.
  fn('end_trip', "The user wants to end the trip ('we reached, end here', 'stop the trip'). The app asks them to confirm.", {}, []),
]
