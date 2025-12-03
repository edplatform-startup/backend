import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import express from 'express';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';
import feedbackRouter from '../src/routes/feedback.js';

describe('Feedback API', () => {
    let app;
    let mockSelect;
    let mockInsert;
    let mockFrom;
    let mockSchema;
    let mockQueryBuilder;

    beforeEach(() => {
        // Reset mock data and calls
        mockQueryBuilder.eq.mock.resetCalls();
        mockQueryBuilder.order.mock.resetCalls();
        mockQueryBuilder.range.mock.resetCalls();
        mockQueryBuilder._result = { data: [], error: null, count: 0 };
    });

    before(() => {
        app = express();
        app.use(express.json());
        app.use('/feedback', feedbackRouter);

        // Mock Supabase client
        const mockData = { data: [], error: null, count: 0 };

        mockQueryBuilder = {
            select: mock.fn(function () { return this; }),
            insert: mock.fn(function () { return this; }),
            eq: mock.fn(function () { return this; }),
            order: mock.fn(function () { return this; }),
            range: mock.fn(function () { return this; }),
            single: mock.fn(function () { return Promise.resolve(this._result || { data: { id: '123' }, error: null }); }),
            then: function (resolve, reject) {
                return Promise.resolve(this._result || mockData).then(resolve, reject);
            }
        };

        mockFrom = mock.fn(() => mockQueryBuilder);
        mockSchema = mock.fn(() => ({ from: mockFrom }));

        const mockSupabase = {
            schema: mockSchema
        };

        setSupabaseClient(mockSupabase);
    });

    after(() => {
        clearSupabaseClient();
        mock.restoreAll();
    });

    it('GET /feedback should return feedback list', async () => {
        const mockData = [{ id: 1, message: 'test' }];
        mockQueryBuilder._result = { data: mockData, error: null, count: 1 };

        const response = await request(app)
            .get('/feedback')
            .expect('Content-Type', /json/)
            .expect(200);

        assert.strictEqual(response.body.success, true);
        assert.deepStrictEqual(response.body.feedback, mockData);
        assert.strictEqual(response.body.count, 1);
    });

    it('GET /feedback should filter by userId', async () => {
        mockQueryBuilder._result = { data: [], error: null, count: 0 };

        await request(app)
            .get('/feedback?userId=123')
            .expect(200);

        const eqCalls = mockQueryBuilder.eq.mock.calls;
        assert.ok(eqCalls.some(call => call.arguments[0] === 'user_id' && call.arguments[1] === '123'));
    });

    it('GET /feedback should filter by type', async () => {
        mockQueryBuilder._result = { data: [], error: null, count: 0 };

        await request(app)
            .get('/feedback?type=bug')
            .expect(200);

        const eqCalls = mockQueryBuilder.eq.mock.calls;
        assert.ok(eqCalls.some(call => call.arguments[0] === 'type' && call.arguments[1] === 'bug'));
    });

    it('GET /feedback should handle pagination', async () => {
        mockQueryBuilder._result = { data: [], error: null, count: 0 };

        await request(app)
            .get('/feedback?limit=10&offset=5')
            .expect(200);

        const rangeCalls = mockQueryBuilder.range.mock.calls;
        assert.strictEqual(rangeCalls.length, 1);
        assert.strictEqual(rangeCalls[0].arguments[0], 5);
        assert.strictEqual(rangeCalls[0].arguments[1], 14); // 5 + 10 - 1
    });
});
