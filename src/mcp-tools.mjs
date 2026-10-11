#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MtsClient } from './mts-client.mjs';
import { MtsError } from './session.mjs';
import { readOpenPhoneTranscript } from './mts-phone.mjs';
import { collectOpenPhoneTranscript } from './mts-phone-scroll.mjs';

export function createMtsServer({ client = new MtsClient(), includePhone = true } = {}) {
const server = new McpServer({ name: 'mts-calls', version: '0.1.0' });
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
function register(name, description, inputSchema, handler, toolAnnotations = annotations) {
  server.registerTool(name, { description, inputSchema, annotations: toolAnnotations }, async (args, context) => {
    try {
      const data = await handler(args, context);
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
      const safe = error instanceof MtsError ? { code: error.code, message: error.message, status: error.status } : { code: 'internal_error', message: 'Не удалось выполнить запрос МТС.' };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(safe) }] };
    }
  });
}
register('mts_connection_status', 'Проверить настройку сессии МТС. verify=true проверяет доступ к API. Секреты не возвращаются.', z.object({ verify: z.boolean().default(false) }), args => client.status(args));
register('mts_list_calls', 'Получить страницу звонков Мой МТС с идентификаторами записей и статусами готовности расшифровок. По умолчанию от новых к старым.', z.object({ limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().nonnegative().default(0), order_by: z.enum(['asc', 'desc']).default('desc') }), args => client.listCalls({ limit: args.limit, offset: args.offset, orderBy: args.order_by }));
register('mts_get_transcript', 'Получить расшифровку и итоги записи. Реплики сохраняют автора и время. Выбирай записи с transcription_status=done; для неподготовленной записи МТС может начать обработку и вернуть processing.', z.object({ call_id: z.string().min(1).max(256), record_id: z.string().min(1).max(256) }), args => client.getTranscript({ callId: args.call_id, recordId: args.record_id }), { ...annotations, readOnlyHint: false });
register('mts_search_transcripts', 'Найти фразу в готовых расшифровках последних звонков. Пропускает неподготовленные записи и сообщает число проверенных звонков/записей.', z.object({ query: z.string().trim().min(1).max(500), max_calls: z.number().int().min(1).max(200).default(50) }), args => client.searchTranscripts({ query: args.query, maxCalls: args.max_calls }));
if (includePhone) {
register('mts_read_open_transcript', 'Прочитать видимый фрагмент полной расшифровки, открытой в «Мой МТС» на Android, подключённом по USB. Работает без сессии API. Не прокручивает экран; не гарантирует полноту разговора.', z.object({}), () => readOpenPhoneTranscript());
register('mts_collect_open_transcript', 'Собрать текст открытого разговора в «Мой МТС» на Android через USB: автоматически прокручивает к началу и далее к концу. Сохраняет исходные экраны и приблизительно склеивает перекрытия. Меняет положение прокрутки. Телефон должен быть разблокирован. Границы и ограничения покрытия указываются в результате.', z.object({ max_screens: z.number().int().min(1).max(40).default(20) }), (args, context) => collectOpenPhoneTranscript({ maxScreens: args.max_screens, signal: context.signal }), { ...annotations, readOnlyHint: false });
}
return server;
}
