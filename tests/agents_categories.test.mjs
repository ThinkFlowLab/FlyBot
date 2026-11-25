import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  AGENT_CATEGORIES,
  categoryFromSearch,
  searchWithCategory,
} from '../flybot_workspace/static/agents/app.mjs';

const agentsHtml = readFileSync(
  new URL('../flybot_workspace/static/agents/index.html', import.meta.url), 'utf8');
const discoverHtml = readFileSync(
  new URL('../flybot_workspace/static/discover/index.html', import.meta.url), 'utf8');

test('the agents directory carries the 17 target categories in the recorded order', () => {
  assert.deepEqual(AGENT_CATEGORIES.map((entry) => entry.label), [
    'Content Creation', 'Customer Support', 'Data Analysis', 'Design',
    'Education', 'Engineering', 'Finance', 'IT & Security', 'Investment',
    'Legal', 'Life', 'Marketing', 'Operations', 'Product', 'Recruiting',
    'Research', 'Sales',
  ]);
  assert.equal(AGENT_CATEGORIES.length, 17);
  const slugs = AGENT_CATEGORIES.map((entry) => entry.slug);
  assert.equal(new Set(slugs).size, 17);
  for (const slug of slugs) assert.match(slug, /^[a-z]+(-[a-z]+)*$/);
});

test('every category pill is a live button that maps to its slug', () => {
  const row = agentsHtml.split('class="filter-row"')[1].split('id="creator-filter"')[0];
  assert.doesNotMatch(row, /disabled/);
  assert.match(row, /data-category="all"[^>]*aria-pressed="true"[^>]*>全部</);
  const positions = ['全部', ...AGENT_CATEGORIES.map((entry) => entry.label.replaceAll('&', '&amp;'))]
    .map((label) => row.indexOf(`>${label}<`));
  assert.equal(positions.every((index) => index !== -1), true);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  for (const entry of AGENT_CATEGORIES) {
    assert.match(row, new RegExp(`data-category="${entry.slug}"`));
  }
});

test('?category= keeps the selection and the empty selection drops it', () => {
  assert.equal(categoryFromSearch('?category=engineering'), 'engineering');
  assert.equal(categoryFromSearch('?category=it-security'), 'it-security');
  assert.equal(categoryFromSearch('?category=sales'), 'sales');
  assert.equal(categoryFromSearch('?category=all'), 'all');
  assert.equal(categoryFromSearch('?q=x&category=design'), 'design');
  assert.equal(categoryFromSearch('?category=not-a-category'), 'all');
  assert.equal(categoryFromSearch(''), 'all');
  assert.equal(categoryFromSearch(undefined), 'all');
  assert.equal(searchWithCategory('', 'sales'), '?category=sales');
  assert.equal(searchWithCategory('?category=sales', 'all'), '');
  assert.equal(searchWithCategory('?category=sales', 'design'), '?category=design');
});

test('the public catalog empty state and the workspace empty state stay distinct', () => {
  assert.match(agentsHtml, /这个工作区还没有智能体。/);
  assert.match(discoverHtml, /暂无公开智能体/);
  assert.doesNotMatch(discoverHtml, /还没有收录任何智能体/);
});
