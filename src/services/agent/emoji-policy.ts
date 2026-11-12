
import prisma from '../../config/prisma';
 
export const REPLY_EMOJI = {
  welcome: '\u{1F90D}',
  packageChosen: '\u{1F930}',
  slotAvailable: '\u{1F4C5}',
  paymentConfirmed: '\u2705',
  location: '\u{1F4CD}',
  reminder: '\u{1F4F8}',
  family: '\u{1F380}',
  closing: '\u{1F90D}',
  nameCaptured: '\u{1F338}',
  addonNoted: '\u{1F490}',
  extrasQuestion: '\u{1F476}',
  timeOptions: '\u{1F4C5}',
  sessionReminder: '\u{1F54A}\uFE0F',
  delivery: '\u{1F4F8}',
  thankYou: '\u{1F60A}',
} as const;

export type EmojiReplyType = keyof typeof REPLY_EMOJI | 'other';

export const EMOJI_LEVEL: 'restrained' | 'warm' = 'warm';

const restrainedTypes: readonly EmojiReplyType[] = [
  'welcome',
  'slotAvailable',
  'packageChosen',
  'paymentConfirmed',
  'closing',
];

export const EMOJI_LEVEL_SETTINGS = {
  restrained: {
    maximum: 1,
    greetingClosingMaximum: 2,
    replyTypes: restrainedTypes,
    repeatRule: 'never_consecutive',
    shortListStarts: false,
    modelSuggestions: false,
    mirrorCustomer: true,
  },
  warm: {
    maximum: 2,
    greetingClosingMaximum: 3,
    replyTypes: [
      ...restrainedTypes,
      'nameCaptured',
      'addonNoted',
      'extrasQuestion',
      'timeOptions',
      'sessionReminder',
      'delivery',
      'thankYou',
      'location',
      'reminder',
      'family',
    ] as readonly EmojiReplyType[],
    repeatRule: 'after_one_different_reply',
    shortListStarts: true,
    modelSuggestions: true,
    mirrorCustomer: false,
  },
} as const;

export const EMOJI_POLICY = {
  ...EMOJI_LEVEL_SETTINGS[EMOJI_LEVEL],
  maximumReplyLength: 4096,
} as const;

export const EMOJI_WHITELIST: readonly string[] = [
  ...new Set([
    ...Object.values(REPLY_EMOJI),

    // Warmth / appreciation
    '\u{1F90D}', // \u{1F90D}
    '\u{1F49B}', // \u{1F49B}
    '\u{1F49C}', // \u{1F49C}
    '\u{1F499}', // \u{1F499}
    '\u{1F9E1}', // \u{1F9E1}
    '\u{1F60A}', // \u{1F60A}
    '\u{1F970}', // \u{1F970}
    '\u{1F642}', // \u{1F642}
    '\u{1F917}', // \u{1F917}
    '\u{1FAF6}', // \u{1FAF6}

    // Greetings / conversation
    '\u{1F44B}', // \u{1F44B}
    '\u{1F44F}', // \u{1F44F}
    '\u{1F44D}', // \u{1F44D}
    '\u{1F64C}', // \u{1F64C}
    '\u{1F602}', // \u{1F602}
    '\u{1F605}', // \u{1F605}
    '\u{1F648}', // \u{1F648}

    // Celebration / excitement
    '\u{2728}',  // \u{2728}
    '\u{1F389}', // \u{1F389}
    '\u{1F38A}', // \u{1F38A}
    '\u{1F31F}', // \u{1F31F}

    // Maternity / beauty / styling
    '\u{1F337}', // \u{1F337}
    '\u{1F338}', // \u{1F338}
    '\u{1F33A}', // \u{1F33A}
    '\u{1F490}', // \u{1F490}
    '\u{1F457}', // \u{1F457}
    '\u{1F484}', // \u{1F484}
    '\u{1F476}', // \u{1F476}
    '\u{1F380}', // \u{1F380}

    // Photography / studio
    '\u{1F4F8}', // \u{1F4F8}
    '\u{1F4F7}', // \u{1F4F7}

    // Calendar / location / confirmation
    '\u{1F4C5}', // \u{1F4C5}
    '\u{1F4CD}', // \u{1F4CD}
    '\u2705',    // \u{2705}
  ]),
];
export const EMOJI_PROMPT_RULE = `Emojis should make the conversation feel warm and natural, never automated or decorated. Density: ${EMOJI_LEVEL}; at most ${EMOJI_POLICY.maximum} per message, ${EMOJI_POLICY.greetingClosingMaximum} in greetings or closings.

${EMOJI_POLICY.modelSuggestions
  ? `You may use emojis, but only choose from this approved whitelist:
${EMOJI_WHITELIST.join(' ')}

Use an emoji only when it genuinely adds warmth, emotion or context. Good examples include \u{1F90D} for warmth or reassurance, \u{2728} for excitement, \u{1F337} or \u{1F338} for a warm maternity/beauty context, \u{1F457} for outfits, \u{1F4F8} for photography, \u{1FAF6} for appreciation, \u{1F60A} for a friendly response, and \u{1F389} for genuine celebration.

Do not force an emoji into every reply. Most replies can contain no emoji. Never invent or use an emoji outside the approved whitelist.`
  : 'Prefer plain text and mirror customer tone.'}

Never repeat an emoji from the immediately previous reply. Never decorate money, deposits, invoices, payment failures, cancellations, refunds, escalation, team-confirmation lines or replies to upset customers.`;

export const EMOJI_REPEAT_WINDOW_MS = 2 * 60 * 60 * 1000;

const segmenter = new Intl.Segmenter('en', {
  granularity: 'grapheme',
});

const emojiPattern =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Presentation}|\u20e3/u;

export type EmojiContext = {
  replyType?: EmojiReplyType;
  userMessage?: string;
  sentimentScore?: number;
  previousAssistant?: string;
  previousAssistantCreatedAt?: Date | number | string | null;
  forbidden?: boolean;
  mode?: 'model' | 'template';
  log?: (reason: string) => void;
};

export function emojisIn(text: string): string[] {
  return [...segmenter.segment(text)]
    .map(value => value.segment)
    .filter(value => emojiPattern.test(value));
}

export function stripEmojis(text: string): string {
  return [...segmenter.segment(text)]
    .filter(value => !emojiPattern.test(value.segment))
    .map(value => value.segment)
    .join('');
}

export function stripAssistantEmojis<
  Message extends { role: string; content: string },
>(history: Message[]): Message[] {
  return history.map(message =>
    message.role === 'assistant'
      ? { ...message, content: stripEmojis(message.content) }
      : message,
  );
}

export function emojiForbiddenReason(
  reply: string,
  context: EmojiContext,
): string | null {
  if (context.forbidden) return 'protected_context';

  if ((context.sentimentScore ?? 0) < 0) {
    return 'negative_sentiment';
  }

  if (
    /\b(?:kshs?|kes|shs|usd|prices?|pricing|costs?|fees?|deposits?|balances?|invoices?|receipts?)\b|[$\u20ac\u00a3]/i.test(
      reply,
    )
  ) {
    return 'financial';
  }

  if (
    /\b(?:fail\w*|cancel\w*|refund\w*|complaints?|escalat\w*|sorry|could not|couldn't|unable|not received)\b/i.test(
      reply,
    )
  ) {
    return 'failure_or_handoff';
  }

  if (
    /\b(?:team|studio|member of (?:our|the) team)\b[\s\S]{0,80}\b(?:confirm|verify|check|help|pick this up|contact)\b/i.test(
      reply,
    )
  ) {
    return 'team_confirmation';
  }

  const replyType = context.replyType || 'other';

  if (
    !EMOJI_POLICY.replyTypes.includes(replyType) &&
    !(EMOJI_POLICY.modelSuggestions && context.mode !== 'template')
  ) {
    return 'reply_type';
  }

  if (
    EMOJI_POLICY.mirrorCustomer &&
    !emojisIn(context.userMessage || '').length &&
    !['welcome', 'closing', 'paymentConfirmed', 'slotAvailable'].includes(
      replyType,
    )
  ) {
    return 'formal_tone';
  }

  return null;
}

export function applyEmojiPolicy(
  reply: string,
  context: EmojiContext = {},
): string {
  const segments = [...segmenter.segment(reply)];
  const found = segments.filter(value => emojiPattern.test(value.segment));

  if (!found.length) return reply;

  const reasons = new Set<string>();
  const hasUnwhitelistedEmoji = found.some(
    value => !EMOJI_WHITELIST.includes(value.segment),
  );
  const templateEmojiSet = new Set<string>(Object.values(REPLY_EMOJI));
  const forbidden = emojiForbiddenReason(reply, context);

  const maximum = ['welcome', 'closing'].includes(
    context.replyType || '',
  )
    ? EMOJI_POLICY.greetingClosingMaximum
    : EMOJI_POLICY.maximum;

  const isStale = Boolean(
    context.previousAssistantCreatedAt &&
      Date.now() -
        new Date(context.previousAssistantCreatedAt).getTime() >=
        EMOJI_REPEAT_WINDOW_MS,
  );

  const previous = !isStale
    ? new Set(emojisIn(context.previousAssistant || ''))
    : new Set<string>();

  let kept = 0;
  const used = new Set<string>();

  const result = segments
    .map(value => {
      if (!emojiPattern.test(value.segment)) {
        return value.segment;
      }

      let reason = forbidden;

      if (
        !reason &&
        hasUnwhitelistedEmoji &&
        EMOJI_WHITELIST.includes(value.segment)
      ) {
        reason = 'mixed_unwhitelisted_emoji';
      }

      if (
        !reason &&
        context.replyType &&
        context.replyType !== 'other' &&
        context.mode !== 'model' &&
        !templateEmojiSet.has(value.segment)
      ) {
        reason = 'template_emoji_mismatch';
      }

      if (!reason && !EMOJI_WHITELIST.includes(value.segment)) {
        reason = 'not_whitelisted';
      }

      const before = reply.slice(0, value.index).trimEnd();

      const after = reply.slice(
        value.index + value.segment.length,
      );

      const priorEmoji = emojiPattern.test(
        [...segmenter.segment(before)].at(-1)?.segment || '',
      );

      const lineEnd =
        /^\s*(?:\n|$)/.test(after) ||
        !stripEmojis(after).trim();

      const sentenceEnd =
        /[.!?]$/.test(before) &&
        (lineEnd || /^\s+[A-Z]/.test(after));

      const line = reply.slice(0, value.index).split('\n').at(-1) || '';

      const listLines = reply
        .split('\n')
        .filter(value => value.trim());

      const shortListStart =
        EMOJI_POLICY.shortListStarts &&
        listLines.length >= 2 &&
        listLines.length <= 3 &&
        listLines.every(value => value.length <= 100) &&
        /^\s*(?:[-*]\s+)?$/.test(line) &&
        /^\s+\S/.test(after) &&
        !emojiPattern.test(
          [...segmenter.segment(after.trimStart())][0]?.segment || '',
        );

      if (
        !reason &&
        !shortListStart &&
        (!before || priorEmoji || (!sentenceEnd && !lineEnd))
      ) {
        reason = 'placement';
      }

      if (!reason && (kept >= maximum || used.has(value.segment))) {
        reason = 'maximum';
      }

      if (
        !reason &&
        ['never_consecutive', 'after_one_different_reply'].includes(
          EMOJI_POLICY.repeatRule,
        ) &&
        previous.has(value.segment)
      ) {
        reason = 'consecutive_repeat';
      }

      if (reason) {
  reasons.add(reason);

  if (reason === 'not_whitelisted') {
    console.info(
      `[AGENT_FLOW] emoji=stripped reason=not_whitelisted emoji=${value.segment}`,
    );
  }

  return '';
}

      used.add(value.segment);
      kept++;

      return shortListStart ? value.segment : ` ${value.segment}`;
    })
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  if (result.length > EMOJI_POLICY.maximumReplyLength) {
    reasons.add('length');
    kept = 0;
  }

  for (const reason of reasons) {
    (
      context.log ||
      (value => console.info(`[AGENT_FLOW] emoji=stripped reason=${value}`))
    )(reason);
  }

  return kept
    ? result
    : stripEmojis(result).replace(/[ \t]{2,}/g, ' ').trim();
}

export function templateEmojiReply(
  reply: string,
  replyType: EmojiReplyType,
  context: EmojiContext = {},
): string {
  if (
    replyType === 'other' ||
    emojiForbiddenReason(reply, { ...context, replyType })
  ) {
    return reply;
  }

  const emoji = REPLY_EMOJI[replyType];
  const sentence = reply.match(/[.!?](?=\s|$)/);

  if (!sentence || sentence.index === undefined) {
    return reply;
  }

  const end = sentence.index + 1;

  return applyEmojiPolicy(
    `${reply.slice(0, end)} ${emoji}${reply.slice(end)}`,
    { ...context, replyType, mode: 'template' },
  );
}

export function emojiReplyType(reply: string): EmojiReplyType {
  if (
    /\b(?:payment received|payment succeeded|deposit has been paid)\b/i.test(
      reply,
    )
  ) {
    return 'paymentConfirmed';
  }

  if (
    /\b(?:you are welcome|you're welcome|thank you|thanks)\b/i.test(
      reply,
    )
  ) {
    return EMOJI_POLICY.replyTypes.includes('thankYou')
      ? 'thankYou'
      : 'closing';
  }

  if (/\b(?:welcome|hello|hi)\b/i.test(reply)) {
    return 'welcome';
  }

  if (
    /\b(?:looking forward|can't wait to meet|see you soon)\b/i.test(reply)
  ) {
    return 'closing';
  }

  if (
    /\b(?:have your name (?:as|saved)|name (?:is )?saved|nice to meet you)\b/i.test(
      reply,
    )
  ) {
    return 'nameCaptured';
  }

  if (/\bnoted for your session\b/i.test(reply)) {
    return 'addonNoted';
  }

  if (
    /\b(?:any extras|would you like to add|like any extras)\b/i.test(reply)
  ) {
    return 'extrasQuestion';
  }

  if (/\b(?:which.*times|what time|these times)\b/i.test(reply)) {
    return 'timeOptions';
  }

  if (/\b(?:reminder|see you tomorrow)\b/i.test(reply)) {
    return 'sessionReminder';
  }

  if (
    /\b(?:edited photos|working days|photo delivery)\b/i.test(reply)
  ) {
    return 'delivery';
  }

  if (
    /\b(?:diamond plaza|4th avenue|we are at|our location)\b/i.test(reply)
  ) {
    return 'location';
  }

  if (
    /\b(?:available|is open)\b/i.test(reply) &&
    /\b(?:am|pm|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
      reply,
    )
  ) {
    return 'slotAvailable';
  }

  return 'other';
}

export async function enforceEmojiPolicy(
  customerId: string,
  platform: string,
  reply: string,
  context: EmojiContext,
): Promise<string> {
  let result = applyEmojiPolicy(reply, context);

  if (!emojisIn(result).length) return result;

  const suppress = (reason: string) =>
    applyEmojiPolicy(result, {
      ...context,
      forbidden: true,
      log: () =>
        console.info(`[AGENT_FLOW] emoji=stripped reason=${reason}`),
    });

  try {
    const session = await prisma.unifiedConversation.findFirst({
      where: {
        customerId,
        endedAt: null,
        OR: [
          { primaryChannel: platform },
          { channels: { has: platform } },
        ],
      },
      orderBy: { lastActivityAt: 'desc' },
      select: { sessionId: true, startedAt: true },
    });

    const latest = await prisma.message.findFirst({
      where: {
        customerId,
        platform,
        direction: 'outbound',
        ...(session
          ? { createdAt: { gte: session.startedAt } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, content: true, createdAt: true },
    });

    const latestStale = Boolean(
      latest?.createdAt &&
        Date.now() -
          new Date(latest.createdAt).getTime() >=
          EMOJI_REPEAT_WINDOW_MS,
    );

    const previousAssistantContent = !latestStale
      ? latest?.content || context.previousAssistant
      : undefined;

    const previousAssistantCreatedAt = !latestStale
      ? latest?.createdAt || context.previousAssistantCreatedAt
      : undefined;

    result = applyEmojiPolicy(result, {
      ...context,
      previousAssistant: previousAssistantContent,
      previousAssistantCreatedAt,
    });

    if (!emojisIn(result).length) return result;

    const prefix = `system:emoji-last:v1:${encodeURIComponent(
      session?.sessionId || `thread:${platform}`,
    )}:`;

    await prisma.customerMemory.upsert({
      where: { customerId },
      update: {},
      create: { customerId },
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const memory = await prisma.customerMemory.findUnique({
        where: { customerId },
        select: { keyInsights: true },
      });

      if (!memory) return suppress('state_unavailable');

      const prior = memory.keyInsights.find(value =>
        value.startsWith(prefix),
      );

      if (prior) {
        const state = JSON.parse(
          prior.slice(prefix.length),
        ) as {
          priorMessageId: string | null;
          emojis: string[];
          timestamp?: number;
        };

        const stateStale = Boolean(
          state.timestamp &&
            Date.now() - state.timestamp >= EMOJI_REPEAT_WINDOW_MS,
        );

        if (
          !stateStale &&
          !latestStale &&
          state.priorMessageId === (latest?.id || null)
        ) {
          result = applyEmojiPolicy(result, {
            ...context,
            previousAssistant: state.emojis.join(' '),
            previousAssistantCreatedAt: latest?.createdAt,
          });

          if (!emojisIn(result).length) return result;
        }
      }

      const marker =
        prefix +
        JSON.stringify({
          priorMessageId: latest?.id || null,
          emojis: emojisIn(result),
          timestamp: Date.now(),
        });

      const claimed = await prisma.customerMemory.updateMany({
        where: {
          customerId,
          keyInsights: { equals: memory.keyInsights },
        },
        data: {
          keyInsights: {
            set: [
              ...memory.keyInsights.filter(
                value => !value.startsWith(prefix),
              ),
              marker,
            ],
          },
        },
      });

      if (claimed.count === 1) return result;
    }

    return suppress('state_conflict');
  } catch {
    return suppress('state_unavailable');
  }
}
