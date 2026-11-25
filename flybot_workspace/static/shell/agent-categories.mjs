export const AGENT_CATEGORIES = [
  {slug: 'content-creation', label: 'Content Creation'},
  {slug: 'customer-support', label: 'Customer Support'},
  {slug: 'data-analysis', label: 'Data Analysis'},
  {slug: 'design', label: 'Design'},
  {slug: 'education', label: 'Education'},
  {slug: 'engineering', label: 'Engineering'},
  {slug: 'finance', label: 'Finance'},
  {slug: 'it-security', label: 'IT & Security'},
  {slug: 'investment', label: 'Investment'},
  {slug: 'legal', label: 'Legal'},
  {slug: 'life', label: 'Life'},
  {slug: 'marketing', label: 'Marketing'},
  {slug: 'operations', label: 'Operations'},
  {slug: 'product', label: 'Product'},
  {slug: 'recruiting', label: 'Recruiting'},
  {slug: 'research', label: 'Research'},
  {slug: 'sales', label: 'Sales'},
];

export const AGENT_CATEGORY_SLUGS = new Set(AGENT_CATEGORIES.map((entry) => entry.slug));

export function categoryFromSearch(search) {
  const slug = new URLSearchParams((search || '').replace(/^\?/, '')).get('category') || '';
  return AGENT_CATEGORY_SLUGS.has(slug) ? slug : 'all';
}

export function categoryLabel(slug) {
  const found = AGENT_CATEGORIES.find((entry) => entry.slug === slug);
  return found ? found.label : '';
}
