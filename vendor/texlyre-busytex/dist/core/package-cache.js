// src/core/package-cache.ts
import { PACKAGE_VERSION } from './version';
const EM_CACHE_DB = 'EM_PRELOAD_CACHE';
const PACKAGES_STORE = 'PACKAGES';
const METADATA_STORE = 'METADATA';
const CACHE_VERSION_KEY = 'texlyre-busytex-version';
function dataFileName(packageJsUrl) {
    const name = packageJsUrl.split('/').pop() || '';
    return name.replace(/\.js$/, '.data');
}
export async function ensureCacheVersion() {
    if (typeof localStorage === 'undefined')
        return;
    if (localStorage.getItem(CACHE_VERSION_KEY) === PACKAGE_VERSION)
        return;
    await clearAllPackageCache();
    localStorage.setItem(CACHE_VERSION_KEY, PACKAGE_VERSION);
}
async function openEmCache() {
    await ensureCacheVersion();
    return new Promise(resolve => {
        if (typeof indexedDB === 'undefined')
            return resolve(null);
        const request = indexedDB.open(EM_CACHE_DB);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onupgradeneeded = () => {
            try {
                request.transaction?.abort();
            }
            catch { }
            resolve(null);
        };
    });
}
async function findMetadataKey(db, dataFile) {
    if (!db.objectStoreNames.contains(METADATA_STORE))
        return null;
    return await new Promise(resolve => {
        const tx = db.transaction(METADATA_STORE, 'readonly');
        const req = tx.objectStore(METADATA_STORE).getAllKeys();
        req.onsuccess = () => {
            const keys = req.result;
            const match = keys.find(k => String(k).endsWith(`/${dataFile}`));
            resolve(match ?? null);
        };
        req.onerror = () => resolve(null);
    });
}
export async function isPackageCached(packageJsUrl) {
    const db = await openEmCache();
    if (!db)
        return false;
    try {
        const key = await findMetadataKey(db, dataFileName(packageJsUrl));
        return key !== null;
    }
    finally {
        db.close();
    }
}
export async function deletePackageCache(packageJsUrl) {
    const db = await openEmCache();
    if (!db)
        return;
    const dataFile = dataFileName(packageJsUrl);
    try {
        const metadataKey = await findMetadataKey(db, dataFile);
        if (!metadataKey)
            return;
        const stores = [METADATA_STORE];
        if (db.objectStoreNames.contains(PACKAGES_STORE))
            stores.push(PACKAGES_STORE);
        await new Promise(resolve => {
            const tx = db.transaction(stores, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
            tx.objectStore(METADATA_STORE).delete(metadataKey);
            if (stores.includes(PACKAGES_STORE)) {
                const pkgPrefix = String(metadataKey).replace(/^metadata\//, 'package/');
                const store = tx.objectStore(PACKAGES_STORE);
                const cursorReq = store.openKeyCursor();
                cursorReq.onsuccess = () => {
                    const cursor = cursorReq.result;
                    if (!cursor)
                        return;
                    const k = String(cursor.key);
                    if (k.startsWith(pkgPrefix + '/'))
                        store.delete(cursor.key);
                    cursor.continue();
                };
            }
        });
    }
    finally {
        db.close();
    }
}
export async function clearAllPackageCache() {
    if (typeof indexedDB === 'undefined')
        return;
    await new Promise(resolve => {
        const req = indexedDB.deleteDatabase(EM_CACHE_DB);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
    });
}
//# sourceMappingURL=package-cache.js.map