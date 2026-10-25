const score = {
    type: 'object', additionalProperties: false, required: ['name', 'ms', 'platform', 'achievedAt'],
    properties: {
        name: { type: 'string', pattern: '^[A-Z0-9._-]{1,3}$' },
        ms: { type: 'integer', minimum: 1, maximum: 5999999 },
        platform: { type: 'string', enum: ['3ds', 'xbox'] },
        achievedAt: { type: 'integer', minimum: 1577836800, description: 'Unix seconds; no later than server time + 300 seconds.' },
    },
};
const submission = {
    type: 'object', additionalProperties: false, required: ['id', 'course', 'name', 'ms', 'achievedAt'],
    properties: {
        id: { type: 'string', pattern: '^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$', description: 'Client-generated UUID or 32 hex digits; case and hyphens normalized.' },
        course: { type: 'string', pattern: '^[a-z0-9_-]{1,31}$', description: 'Racemap venue ID shared by both console ports.' },
        name: score.properties.name, ms: score.properties.ms, achievedAt: score.properties.achievedAt,
    },
};
const json = schema => ({ 'application/json': { schema } });
const response = (description, schema) => ({ description, content: json(schema) });
const error = { type: 'object', required: ['error'], properties: { error: { type: 'string' } } };
const storedScore = {
    type: 'object', additionalProperties: false,
    required: ['id', 'course', 'name', 'ms', 'platform', 'achievedAt'],
    properties: { ...submission.properties, id: { type: 'string', pattern: '^[a-f0-9]{32}$' }, platform: score.properties.platform },
};

export const openapi = {
    openapi: '3.0.3',
    info: { title: 'Hackertours Racing Highscores API', version: '1.0.0', description: 'Shared public leaderboard for Nintendo 3DS and Xbox 360. Authenticated console submissions are client-reported, not cheat-proof.' },
    servers: [{ url: '/' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, schemas: { Score: score, Submission: submission, StoredScore: storedScore } },
    paths: {
        '/healthz': { get: { operationId: 'getHealth', summary: 'Check the service and database', responses: { 200: response('Healthy', { type: 'object', properties: { status: { type: 'string', enum: ['ok'] } } }) } } },
        '/api/courses': { get: { operationId: 'getCourses', summary: 'List courses with scores', responses: { 200: response('Course summaries sorted by course', { type: 'array', items: { type: 'object', required: ['course', 'count', 'bestMs'], properties: { course: submission.properties.course, count: { type: 'integer', minimum: 1 }, bestMs: score.properties.ms } } }) } } },
        '/api/scores/{course}': { get: {
            operationId: 'getScores', summary: 'Get all scores, fastest first; ties use earlier achievedAt, then id',
            parameters: [
                { name: 'course', in: 'path', required: true, schema: submission.properties.course },
                { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 9007199254740991 }, description: 'Optional positive integer. Omit to return every score; unknown courses return [].' },
            ],
            responses: { 200: response('Ranked scores', { type: 'array', items: score }), 400: response('Invalid course or limit', error) },
        } },
        '/api/scores': { post: {
            operationId: 'submitScore', summary: 'Submit a score (60 requests per client per minute)', security: [{ bearer: [] }],
            description: 'Keycloak RS256 access token with issuer, exp, iat, sub and allowed azp required. Platform comes from azp, never the body. Send application/json, at most 4096 bytes. Only the five documented fields are accepted. Duplicate id returns the existing row unchanged, even if valid submitted fields differ.',
            requestBody: { required: true, content: json(submission) },
            responses: {
                200: response('Idempotent retry; existing score', storedScore), 201: response('Score created', storedScore),
                400: response('Malformed JSON, invalid fields, wrong content type, or oversized body', error),
                401: response('Missing, invalid or expired access token', error), 403: response('Token client is not allowed', error),
                429: { ...response('Client quota exhausted', error), headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until next minute.' } } },
            },
        } },
    },
};
