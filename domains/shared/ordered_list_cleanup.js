"use strict";

function createOrderedListCleanup({
  batchSize = 20,
  maxPasses = 20,
  delayMs = 1500,
  logError = () => {},
} = {}) {
  const timerMap = new Map();
  const inProgress = new Set();

  async function trimOrderedListByTime(listRef, maxItems) {
    if (!listRef || maxItems <= 0) {
      return;
    }

    const queryLimit = maxItems + batchSize;

    for (let pass = 0; pass < maxPasses; pass++) {
      const snap = await listRef
        .orderByChild("time")
        .limitToFirst(queryLimit)
        .once("value");
      const orderedKeys = [];

      snap.forEach((childSnap) => {
        if (childSnap.key) {
          orderedKeys.push(childSnap.key);
        }
      });

      if (orderedKeys.length <= maxItems) {
        return;
      }

      const removeCount = orderedKeys.length - maxItems;
      const updates = {};

      for (const key of orderedKeys.slice(0, removeCount)) {
        updates[key] = null;
      }

      await listRef.update(updates);

      if (orderedKeys.length < queryLimit) {
        return;
      }
    }
  }

  function queueOrderedListCleanup(cleanupKey, listRef, maxItems) {
    if (!cleanupKey || !listRef || maxItems <= 0 || timerMap.has(cleanupKey)) {
      return;
    }

    const timer = setTimeout(async () => {
      timerMap.delete(cleanupKey);

      if (inProgress.has(cleanupKey)) {
        queueOrderedListCleanup(cleanupKey, listRef, maxItems);
        return;
      }

      inProgress.add(cleanupKey);

      try {
        await trimOrderedListByTime(listRef, maxItems);
      } catch (error) {
        logError(cleanupKey, error);
      } finally {
        inProgress.delete(cleanupKey);
      }
    }, delayMs);

    timerMap.set(cleanupKey, timer);
  }

  function dispose() {
    for (const timer of timerMap.values()) {
      clearTimeout(timer);
    }
    timerMap.clear();
    inProgress.clear();
  }

  return {
    dispose,
    queueOrderedListCleanup,
    trimOrderedListByTime,
  };
}

module.exports = { createOrderedListCleanup };
