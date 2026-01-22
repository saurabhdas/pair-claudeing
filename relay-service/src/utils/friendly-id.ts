/**
 * Friendly ID generator for Jams.
 * Generates human-readable IDs like "curious-purple-panda".
 */

const adjectives = [
  'brave', 'calm', 'clever', 'cool', 'curious', 'eager', 'fast', 'friendly',
  'gentle', 'happy', 'jolly', 'keen', 'kind', 'lively', 'merry', 'nice',
  'proud', 'quick', 'sharp', 'smart', 'swift', 'warm', 'wise', 'witty',
  'agile', 'bold', 'bright', 'crisp', 'daring', 'epic', 'fair', 'grand',
  'humble', 'ideal', 'jazzy', 'lucky', 'mighty', 'noble', 'peppy', 'quiet',
  'rapid', 'serene', 'tender', 'unique', 'vivid', 'wild', 'zesty', 'zen',
];

const colors = [
  'amber', 'azure', 'beige', 'blue', 'coral', 'crimson', 'cyan', 'emerald',
  'gold', 'green', 'indigo', 'ivory', 'jade', 'lavender', 'lime', 'magenta',
  'mint', 'navy', 'olive', 'orange', 'peach', 'pink', 'plum', 'purple',
  'red', 'rose', 'ruby', 'sage', 'salmon', 'silver', 'sky', 'slate',
  'teal', 'turquoise', 'violet', 'white', 'yellow', 'bronze', 'copper', 'pearl',
];

const animals = [
  'badger', 'bear', 'beaver', 'buffalo', 'cat', 'cheetah', 'cobra', 'crane',
  'deer', 'dolphin', 'dragon', 'eagle', 'elephant', 'falcon', 'ferret', 'finch',
  'fox', 'frog', 'gazelle', 'gecko', 'giraffe', 'goat', 'goose', 'hawk',
  'heron', 'horse', 'jaguar', 'koala', 'lemur', 'leopard', 'lion', 'lizard',
  'lynx', 'meerkat', 'moose', 'octopus', 'otter', 'owl', 'panda', 'panther',
  'parrot', 'penguin', 'phoenix', 'python', 'rabbit', 'raven', 'rhino', 'robin',
  'salmon', 'seal', 'shark', 'sloth', 'snake', 'sparrow', 'spider', 'squid',
  'stork', 'swan', 'tiger', 'toucan', 'turtle', 'viper', 'whale', 'wolf',
  'wombat', 'zebra', 'alpaca', 'bison', 'coyote', 'dingo', 'elk', 'ibis',
];

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a friendly ID in the format: adjective-color-animal
 * Examples: "curious-purple-panda", "swift-azure-falcon"
 */
export function generateFriendlyId(): string {
  const adjective = randomElement(adjectives);
  const color = randomElement(colors);
  const animal = randomElement(animals);
  return `${adjective}-${color}-${animal}`;
}

/**
 * Check if a string looks like a valid friendly ID.
 */
export function isValidFriendlyId(id: string): boolean {
  const parts = id.split('-');
  if (parts.length !== 3) return false;
  return parts.every(part => /^[a-z]+$/.test(part));
}
