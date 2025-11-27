export function createSupabaseStub({ listResponses = [], singleResponses = [], insertResponses = [], updateResponses = [], deleteResponses = [] } = {}) {
  const listQueue = [...listResponses];
  const singleQueue = [...singleResponses];
  const insertQueue = [...insertResponses];
  const updateQueue = [...updateResponses];
  const deleteQueue = [...deleteResponses];
  const defaultResponse = { data: null, error: null };

  const supabase = {
    schema() {
      return supabase;
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
    const chain = {
      eq() { return chain; },
      select() { return chain; },
      single() { return Promise.resolve(response); },
    };
    return chain;
  }

  return supabase;
}
