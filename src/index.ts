export function promisifyRequest<T = undefined>(
  request: IDBRequest<T> | IDBTransaction,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // @ts-expect-error - file size hacks
    request.oncomplete = () => resolve(request.result);
    (request as any).onsuccess = () => resolve((request as any).result);
    // @ts-expect-error - file size hacks
    request.onabort = () => reject(request.error);
    request.onerror = () => reject(request.error);
  });
}

type UseStore = <T>(
  txMode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => T | PromiseLike<T>,
) => Promise<T>;

interface CreateStoreOptions {
  dbName: string;
  storeName: string;
}

interface IndexedDBHelperOptions extends CreateStoreOptions {
  size?: number;
}

const DEFAULT_OPTIONS: IndexedDBHelperOptions = {
  dbName: 'keyval-store',
  storeName: 'keyval',
};

const initialError = new Error('The store is not initialized yet');

/**
 * 全局已经打开的 db 库
 */
const openDBRequestByName = new Map<string, IDBOpenDBRequest>();

const getOpenedDBRequest = (dbName: string): IDBOpenDBRequest | null => {
  try {
    let idbRequest = openDBRequestByName.get(dbName);
    if (!idbRequest) {
      idbRequest = indexedDB.open(dbName);
      openDBRequestByName.set(dbName, idbRequest);
    }
    return idbRequest;
  } catch (err) {
    return null;
  }
};

class IndexedDBHelper {
  readonly store: UseStore | undefined;

  constructor(options: IndexedDBHelperOptions = { ...DEFAULT_OPTIONS }) {
    const { dbName, storeName } = {
      ...options,
      ...DEFAULT_OPTIONS,
    };
    this.store = this.createStore({ dbName, storeName });
  }

  get<T = any>(key: IDBValidKey): Promise<T | undefined> {
    if (!this.store) {
      return Promise.reject(initialError);
    }
    return this.store('readonly', store => promisifyRequest(store.get(key)));
  }

  set(key: IDBValidKey, value: any): Promise<void> {
    if (!this.store) {
      return Promise.reject(initialError);
    }
    return this.store('readwrite', store => {
      store.put(value, key);
      return promisifyRequest(store.transaction);
    });
  }

  setMany(entries: [IDBValidKey, any][]): Promise<void> {
    if (!this.store) {
      return Promise.reject(initialError);
    }
    return this.store('readwrite', store => {
      entries.forEach(entry => store.put(entry[1], entry[0]));
      return promisifyRequest(store.transaction);
    });
  }

  getMany<T = any>(keys: IDBValidKey[]): Promise<T[]> {
    if (!this.store) {
      return Promise.reject(initialError);
    }
    return this.store('readonly', store =>
      Promise.all(keys.map(key => promisifyRequest(store.get(key)))),
    );
  }

  update<T = any>(
    key: IDBValidKey,
    updater: (oldValue: T | undefined) => T,
  ): Promise<void> {
    if (!this.store) {
      return Promise.reject(initialError);
    }
    return this.store(
      'readwrite',
      store =>
        // Need to create the promise manually.
        // If I try to chain promises, the transaction closes in browsers
        // that use a promise polyfill (IE10/11).
        new Promise((resolve, reject) => {
          store.get(key).onsuccess = function () {
            try {
              store.put(updater(this.result), key);
              resolve(promisifyRequest(store.transaction));
            } catch (err) {
              reject(err);
            }
          };
        }),
    );
  }

  del(key: IDBValidKey): Promise<void> {
    if (!this.store) {
      return Promise.reject(initialError);
    }
    return this.store('readwrite', store => {
      store.delete(key);
      return promisifyRequest(store.transaction);
    });
  }

  delMany(keys: IDBValidKey[]): Promise<void> {
    if (!this.store) {
      return Promise.reject(initialError);
    }
    return this.store('readwrite', (store: IDBObjectStore) => {
      keys.forEach((key: IDBValidKey) => store.delete(key));
      return promisifyRequest(store.transaction);
    });
  }

  /**
   * Clear all values in the store.
   *
   * @param customStore Method to get a custom store. Use with caution (see the docs).
   */
  clear(): Promise<void> {
    if (!this.store) {
      return Promise.reject(initialError);
    }
    return this.store('readwrite', store => {
      store.clear();
      return promisifyRequest(store.transaction);
    });
  }

  private createStore({
    dbName,
    storeName,
  }: CreateStoreOptions): UseStore | null {
    try {
      const idbRequest = getOpenedDBRequest(dbName);

      if (!idbRequest) {
        return null;
      }

      idbRequest.onupgradeneeded = () =>
        idbRequest.result.createObjectStore(storeName);
      const dbp = promisifyRequest(idbRequest);

      return (txMode, callback) =>
        dbp.then(db =>
          callback(db.transaction(storeName, txMode).objectStore(storeName)),
        );
    } catch (error) {}
    return null;
  }
}

export { IndexedDBHelper };
