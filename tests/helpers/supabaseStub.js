/**
 * Valid test token for authentication in tests.
 * Use this in the Authorization header: `Bearer ${TEST_AUTH_TOKEN}`
 */
export const TEST_AUTH_TOKEN = 'test-valid-jwt-token';

/**
 * Default test user returned by the auth stub when using TEST_AUTH_TOKEN
 */
export const TEST_USER = {
  id: '22222222-2222-2222-2222-222222222222',
  email: 'test@example.com',
  role: 'authenticated',
  user_metadata: {}
};

export function createSupabaseStub({ listResponses = [], singleResponses = [], insertResponses = [], updateResponses = [], deleteResponses = [], storageListResponses = [], storageRemoveResponses = [], authUser = null } = {}) {
  const listQueue = [...listResponses];
  const singleQueue = [...singleResponses];
  const insertQueue = [...insertResponses];
  const updateQueue = [...updateResponses];
  const deleteQueue = [...deleteResponses];
  const storageListQueue = [...storageListResponses];
  const storageRemoveQueue = [...storageRemoveResponses];
  const defaultResponse = { data: null, error: null };

  const supabase = {
    auth: {
      getUser(token) {
        // If authUser is provided, return it as authenticated user
        // If token is 'invalid', return an error
        if (token === 'invalid' || token === 'expired') {
          return Promise.resolve({
            data: { user: null },
            error: { message: 'Invalid or expired token' }
          });
        }
        if (authUser) {
          return Promise.resolve({
            data: { user: authUser },
            error: null
          });
        }
        // Default: return a mock authenticated user
        return Promise.resolve({
          data: {
            user: {
              id: '22222222-2222-2222-2222-222222222222',
              email: 'test@example.com',
              role: 'authenticated',
              user_metadata: {}
            }
          },
          error: null
        });
      }
    },
    schema() {
      return supabase;
    },
    storage: {
      from() {
        return {
          list() {
            const resp = storageListQueue.length ? storageListQueue.shift() : { data: [], error: null };
            return Promise.resolve(resp);
          },
          remove() {
            const resp = storageRemoveQueue.length ? storageRemoveQueue.shift() : { data: [], error: null };
            return Promise.resolve(resp);
          },
        };
      },
    },
    from() {
      const listResp = listQueue.length ? listQueue.shift() : defaultResponse;
      const singleResp = singleQueue.length ? singleQueue.shift() : listResp;

      const promise = Promise.resolve(listResp);
      const chain = promise;

      chain.select = () => chain;
      chain.eq = () => chain;
      chain.contains = () => chain;
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.or = () => chain;
      chain.in = () => chain;

      chain.single = () => Promise.resolve(singleResp);

      chain.insert = (payload) => {
        const insertResp = insertQueue.length ? insertQueue.shift() : defaultResponse;
        if (insertResp && typeof insertResp.onInsert === 'function') {
          insertResp.onInsert(payload);
        }
        const responseForInsert = insertResp && typeof insertResp === 'object' && insertResp.data !== undefined
          ? { data: insertResp.data, error: insertResp.error ?? null }
          : defaultResponse;
        return createInsertChain(responseForInsert);
      };

      chain.update = (payload) => {
        const updateResp = updateQueue.length ? updateQueue.shift() : defaultResponse;
        if (updateResp && typeof updateResp.onUpdate === 'function') {
          updateResp.onUpdate(payload);
        }
        const responseForUpdate = updateResp && typeof updateResp === 'object' && updateResp.data !== undefined
          ? { data: updateResp.data, error: updateResp.error ?? null }
          : defaultResponse;
        return createUpdateChain(responseForUpdate);
      };

      chain.delete = () => {
        const delResp = deleteQueue.length ? deleteQueue.shift() : defaultResponse;
        const responseForDelete = delResp && typeof delResp === 'object' && delResp.data !== undefined
          ? { data: delResp.data, error: delResp.error ?? null }
          : defaultResponse;
        return createUpdateChain(responseForDelete);
      };

      chain.then = promise.then.bind(promise);
      chain.catch = promise.catch.bind(promise);
      chain.finally = promise.finally.bind(promise);

      return chain;
    },
  };

  function createInsertChain(response) {
    const chain = {
      select() {
        return chain;
      },
      single() {
        return Promise.resolve(response);
      },
    };
    return chain;
  }

  function createUpdateChain(response) {
    const promise = Promise.resolve(response);
    const chain = {
      eq() { return chain; },
      select() { return chain; },
      single() { return Promise.resolve(response); },
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
    };
    return chain;
  }

  return supabase;
}
