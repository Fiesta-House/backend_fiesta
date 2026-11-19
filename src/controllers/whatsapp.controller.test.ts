import assert from 'node:assert/strict';
import test from 'node:test';
import prisma from '../config/prisma';
import { agentService } from '../services/agent/agent.service';
import { whatsappService } from '../services/messaging/whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';

function harness(context: any, reply: string, newerInbound: boolean) {
  const restores: (() => void)[] = [];
  const stub = (target: any, method: string, implementation: (...args: any[]) => any) => {
    const original = target[method]; target[method] = implementation; restores.push(() => { target[method] = original; });
  };
  context.after(() => restores.reverse().forEach((restore) => restore()));
  const sent: string[] = [];
  const saved: string[] = [];
  const marked: string[][] = [];
  const pending = [{ id: 'm1', content: 'lets do it on 14th', createdAt: new Date('2026-10-09T13:30:00Z') }];
  stub(prisma.message, 'findMany', async ({ where }: any) => (where.handledBy === 'pending' ? pending : []));
  stub(prisma.message, 'findFirst', async ({ where }: any) => {
    if (where?.content) return { id: 'privacy-notice' };
    return newerInbound ? { id: 'm2' } : null;
  });
  stub(prisma.message, 'create', async ({ data }: any) => { saved.push(data.content); return data; });
  stub(prisma.message, 'updateMany', async ({ where }: any) => { marked.push(where.id.in); return { count: 1 }; });
  stub(agentService, 'handleMessage', async () => reply);
  stub(whatsappService, 'sendMessage', async (_to: string, text: string) => { sent.push(text); });
  const controller = new WhatsAppController() as any;
  return { run: () => controller.processPendingTurn('synthetic-customer'), sent, saved, marked };
}

test('a reply is dropped when she wrote again meanwhile, so the next turn answers both messages', async (context) => {
  const { run, sent, saved, marked } = harness(context, '2:00 PM on Wednesday, 14 October is available.', true);
  await run();
  assert.deepEqual(sent, []);
  assert.deepEqual(saved, []);
  assert.deepEqual(marked, [], 'her messages stay pending for the next turn');
});

test('a reply is sent normally when no newer message arrived', async (context) => {
  const { run, sent, marked } = harness(context, '2:00 PM on Wednesday, 14 October is available.', false);
  await run();
  assert.deepEqual(sent, ['2:00 PM on Wednesday, 14 October is available.']);
  assert.deepEqual(marked, [['m1']]);
});

test('a payment reply is always sent because its action already happened', async (context) => {
  const { run, sent } = harness(context, 'I have sent the M-Pesa prompt for the Ksh 2,000 deposit.', true);
  await run();
  assert.equal(sent.length, 1);
});
