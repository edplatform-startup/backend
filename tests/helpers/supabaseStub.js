export function createSupabaseStub({ listResponses = [], singleResponses = [], insertResponses = [] } = {}) {
  const listQueue = [...listResponses];
  const singleQueue = [...singleResponses];
  const insertQueue = [...insertResponses];
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
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.or = () => chain;

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

  return supabase;
}
