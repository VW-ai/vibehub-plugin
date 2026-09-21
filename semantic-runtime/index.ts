import { generateText } from 'ai';

const { text } = await generateText({
  model: 'openai/gpt-5.5',
  prompt: 'Invent a new holiday and describe its traditions.',
});

if (!text.trim()) throw new Error('AI Gateway returned empty text');
console.log(text);
