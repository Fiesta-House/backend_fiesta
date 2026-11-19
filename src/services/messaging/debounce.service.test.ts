import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { scheduleTurn } from './debounce.service';

// onFlush runs through a promise chain (to serialize turns), so let microtasks settle before asserting.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('scheduleTurn: does not flush before the debounce delay elapses', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let flushCount = 0;
    scheduleTurn('customer-a', () => { flushCount++; });

    mock.timers.tick(5999);
    await settle();
    assert.equal(flushCount, 0, 'should not have flushed yet, one millisecond short of the delay');

    mock.timers.tick(1);
    await settle();
    assert.equal(flushCount, 1, 'should flush right at the debounce delay');
  } finally {
    mock.timers.reset();
  }
});

test('scheduleTurn: a second message resets the timer, resulting in only one flush', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let flushCount = 0;
    scheduleTurn('customer-b', () => { flushCount++; });

    mock.timers.tick(3000); // halfway through the delay
    scheduleTurn('customer-b', () => { flushCount++; }); // customer sends a second message - resets the timer

    mock.timers.tick(3000); // back to where the first timer would have fired
    await settle();
    assert.equal(flushCount, 0, 'the reset should have pushed the flush further out - not fired yet');

    mock.timers.tick(3000); // now the full 6s has passed since the second message
    await settle();
    assert.equal(flushCount, 1, 'should flush exactly once after the reset delay elapses');
  } finally {
    mock.timers.reset();
  }
});

test('scheduleTurn: different customers get independent timers', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const flushed: string[] = [];
    scheduleTurn('customer-c', () => { flushed.push('c'); });
    scheduleTurn('customer-d', () => { flushed.push('d'); });

    mock.timers.tick(6000);
    await settle();
    assert.deepEqual(flushed.sort(), ['c', 'd'], 'both independent customers should have flushed');
  } finally {
    mock.timers.reset();
  }
});

test('scheduleTurn: serializes turns for the same customer when a flush is still running', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const flushed: string[] = [];
    let releaseFirst!: () => void;
    let finishSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondFinished = new Promise<void>((resolve) => { finishSecond = resolve; });

    scheduleTurn('customer-e', async () => {
      flushed.push('first-start');
      await firstGate;
      flushed.push('first-end');
    });
    mock.timers.tick(6000);
    await Promise.resolve();

    scheduleTurn('customer-e', async () => {
      flushed.push('second');
      finishSecond();
    });
    mock.timers.tick(6000);
    await Promise.resolve();

    assert.deepEqual(flushed, ['first-start']);
    releaseFirst();
    await secondFinished;
    assert.deepEqual(flushed, ['first-start', 'first-end', 'second']);
  } finally {
    mock.timers.reset();
  }
});
