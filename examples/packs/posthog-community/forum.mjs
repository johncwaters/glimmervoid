import { runHogQL, runSource, sinceIso } from './posthog-query.mjs';

const QUESTION_URL = 'https://posthog.com/forum/p/';
const TOPIC_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

const ASKED_AT = "parseDateTimeBestEffort(JSONExtractString(attributes, 'createdAt'))";
const CHANGED_AT = "parseDateTimeBestEffort(JSONExtractString(attributes, 'updatedAt'))";
const QUESTIONS_QUERY = [
  'SELECT id, attributes FROM custom.squeak.questions',
  "WHERE JSONExtractString(attributes, 'forumTopic', 'data', 'id') != ''",
  `AND (${ASKED_AT} > parseDateTimeBestEffort({since})`,
  `OR (${CHANGED_AT} > parseDateTimeBestEffort({since}) AND ${ASKED_AT} > parseDateTimeBestEffort({since}) - INTERVAL 14 DAY))`,
  `ORDER BY ${ASKED_AT} > parseDateTimeBestEffort({since}) DESC, ${ASKED_AT} ASC`,
].join(' ');

function recordOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function attributesOf(raw) {
  if (typeof raw !== 'string') return recordOf(raw);
  try {
    return recordOf(JSON.parse(raw));
  } catch {
    return {};
  }
}

function labelOf(relation) {
  const label = recordOf(recordOf(relation).attributes).label;
  return typeof label === 'string' && label.trim() !== '' ? label.trim().slice(0, 100) : null;
}

function itemOf(row) {
  const attributes = attributesOf(row.attributes);
  const permalink = typeof attributes.permalink === 'string' ? attributes.permalink : '';
  const createdAt = typeof attributes.createdAt === 'string' ? attributes.createdAt : '';
  if (permalink === '' || Number.isNaN(Date.parse(createdAt))) return null;
  const firstName = recordOf(recordOf(recordOf(attributes.profile).data).attributes).firstName;
  const topicSlug = recordOf(recordOf(recordOf(attributes.forumTopic).data).attributes).slug;
  const tagRelations = recordOf(attributes.forumTags).data;
  return {
    id: String(row.id),
    title: String(attributes.subject ?? '').slice(0, 300),
    body: String(attributes.body ?? '').slice(0, 20000),
    url: `${QUESTION_URL}${encodeURIComponent(permalink)}`,
    author: typeof firstName === 'string' && firstName.trim() !== '' ? firstName.trim().slice(0, 100) : 'unknown',
    channel: typeof topicSlug === 'string' && TOPIC_SLUG.test(topicSlug) ? topicSlug : null,
    tags: Array.isArray(tagRelations) ? tagRelations.map(labelOf).filter((label) => label !== null).slice(0, 20) : [],
    createdAt: new Date(createdAt).toISOString(),
    resolved: attributes.resolved === true,
  };
}

runSource(async () => (await runHogQL(QUESTIONS_QUERY, { since: sinceIso() })).map(itemOf).filter((item) => item !== null));
