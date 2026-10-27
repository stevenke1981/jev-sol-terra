// Encrypted reasoning items belong to the model that produced them. Replaying one to
// the other model is rejected upstream, so the tracker remembers which model issued each
// reasoning item id and drops the foreign ones from the next Responses request.
// Ids it has never seen are kept: the client may hold items from before this proxy ran.

const REASONING = 'reasoning';
const DONE_EVENT = 'response.output_item.done';

function isReasoningItem(item) {
  return item?.type === REASONING && typeof item.id === 'string' && item.id !== '';
}

/**
 * @param {number} [max] how many reasoning ids to remember; the oldest is forgotten first
 */
export function createReasoningTracker(max = 5000) {
  const owners = new Map();

  /** Remembers that `model` (the upstream id actually sent) produced reasoning item `id`. */
  function record(id, model) {
    if (typeof id !== 'string' || id === '' || !model) return;
    owners.delete(id);
    owners.set(id, model);
    if (owners.size > max) owners.delete(owners.keys().next().value);
  }

  /**
   * Records reasoning items from one upstream event: a streamed
   * `response.output_item.done`, or the `output` array of a plain JSON response.
   */
  function observe(event, model) {
    if (event?.type === DONE_EVENT) {
      if (isReasoningItem(event.item)) record(event.item.id, model);
      return;
    }
    if (Array.isArray(event?.output)) {
      for (const item of event.output) if (isReasoningItem(item)) record(item.id, model);
    }
  }

  /** A copy of `input` without the reasoning items that another model produced. */
  function strip(input, model) {
    if (!Array.isArray(input)) return input;
    return input.filter((item) => !(isReasoningItem(item) && owners.has(item.id) && owners.get(item.id) !== model));
  }

  return { record, observe, strip };
}
