const API_BASE = 'https://api.puzzlebot.top/';

export async function callPuzzleBot(method, params = {}) {
  const token = process.env.PUZZLEBOT_API_TOKEN;
  if (!token) return { skipped: true, reason: 'PUZZLEBOT_API_TOKEN is not configured' };

  const url = new URL(API_BASE);
  url.searchParams.set('token', token);
  url.searchParams.set('method', method);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { code: response.ok ? 0 : response.status, data: text };
  }
}

export async function sendReviewMessage({ text, photoUrl, rewardUrl }) {
  const chatId = process.env.PUZZLEBOT_REVIEW_CHAT_ID;
  if (!chatId) return { skipped: true, reason: 'PUZZLEBOT_REVIEW_CHAT_ID is not configured' };
  const replyMarkup = rewardUrl ? JSON.stringify({
    inline_keyboard: [[{ text: 'Вознаградить', url: rewardUrl }]]
  }) : undefined;

  if (photoUrl) {
    return callPuzzleBot('tg.sendPhoto', {
      chat_id: chatId,
      photo: photoUrl,
      caption: text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    });
  }

  return callPuzzleBot('tg.sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: 'false',
    reply_markup: replyMarkup
  });
}

export async function notifyReward(userTelegramId, points) {
  const command = process.env.PUZZLEBOT_REWARD_COMMAND;
  if (!command || !userTelegramId) return { skipped: true };
  await callPuzzleBot('variableChange', {
    variable: 'points_from_help_in_tasks',
    expression: points,
    user_id: userTelegramId
  });
  return callPuzzleBot('sendCommand', {
    command_name: command,
    tg_chat_id: userTelegramId
  });
}
