// Eight real jobs against the Crumb & Co. sample, each done two ways. Every task
// follows a fixed plan in each world, and the plan is what an agent would do
// next given what the previous step returned.

export const TASKS = [
  {
    job: 'Fix the website',
    title: 'Fix a typo a customer reported ("recieve")',
    evidence: ['site/menu.html', 'recieve'],
    loose: [['grep', 'recieve'], ['cat', 'site/menu.html']],
    index: [['search_source', { query: 'recieve' }], ['read_source', { path: 'site/menu.html', start: 15, end: 19 }]],
  },
  {
    job: 'Fix the website',
    title: 'The scone photo is broken on the menu',
    evidence: ['scone.svg', 'cranberry-scone.svg'],
    loose: [['cat', 'site/menu.html'], ['ls', 'site/images']],
    index: [['follow_references', { path: 'site/menu.html' }], ['list_source', { path: 'site/images' }]],
  },
  {
    job: 'Fix the website',
    title: 'Sold-out items don\'t look sold out',
    evidence: ["classList.add('sold-out')", '.card.is-sold-out'],
    loose: [['grep', 'sold-out'], ['cat', 'site/js/cart.js'], ['cat', 'site/css/site.css']],
    index: [['find_symbol', { name: 'sold-out' }], ['search_source', { query: 'is-sold-out', kind: 'code' }]],
  },
  {
    job: 'Fix the website',
    title: 'Add a Catering link to the navigation',
    evidence: ['site/about.html', 'site/index.html', 'site/menu.html', 'site-nav'],
    loose: [['grep', 'header.html'], ['cat', 'site/includes/header.html']],
    index: [['who_references', { path: 'site/includes/header.html' }], ['read_source', { path: 'site/includes/header.html' }]],
  },
  {
    job: 'Create a web page',
    title: 'Build a new Catering page with an order form',
    evidence: ['Page skeleton', 'New pages', '.field', 'Microcopy', '<!--#include virtual="/includes/header.html" -->'],
    loose: [
      ['ls', 'guidance'], ['cat', 'guidance/web.md'], ['cat', 'guidance/voice.md'],
      ['cat', 'site/about.html'], ['cat', 'site/css/site.css'],
    ],
    index: [
      ['find_rules', { for: 'web' }],
      ['read_source', { path: 'guidance/web.md', section: 'Page skeleton' }],
      ['read_source', { path: 'guidance/web.md', section: 'New pages' }],
      ['read_source', { path: 'guidance/voice.md', section: 'Microcopy' }],
      ['read_source', { path: 'site/about.html' }],
      ['find_symbol', { name: '.field' }],
    ],
  },
  {
    job: 'Make a slide deck',
    title: 'Make a short deck for the holiday menu',
    evidence: ['Punch slides', 'Type and color', '--font-display', 'wall-of-text.md', 'punch-slide.md'],
    loose: [
      ['ls', 'guidance'], ['cat', 'guidance/slides.md'], ['cat', 'site/css/tokens.css'],
      ['ls', 'examples/slides/approved'], ['ls', 'examples/slides/rejected'],
      ['cat', 'examples/slides/approved/punch-slide.md'], ['cat', 'examples/slides/rejected/wall-of-text.md'],
    ],
    index: [
      ['find_rules', { for: 'slides', topic: 'slide' }],
      ['read_source', { path: 'guidance/slides.md', section: 'Structure' }],
      ['read_source', { path: 'guidance/slides.md', section: 'Punch slides' }],
      ['read_source', { path: 'guidance/slides.md', section: 'Type and color' }],
      ['find_symbol', { name: '--font-display' }],
      ['find_examples', { for: 'slides' }],
    ],
  },
  {
    job: 'Draw a figure',
    title: 'Draw how an online order reaches the oven',
    evidence: ['Objects, not words', 'Callout arrows', 'order-flow-v1.svg', 'ticket.svg', '#92400e'],
    loose: [
      ['ls', 'guidance'], ['cat', 'guidance/illustrations.md'], ['cat', 'guidance/arrows.md'],
      ['ls', 'icons'], ['cat', 'icons/ticket.svg'], ['cat', 'site/css/tokens.css'],
      ['ls', 'examples/illustration/approved'], ['ls', 'examples/illustration/rejected'],
      ['cat', 'examples/illustration/approved/order-flow-v2.md'], ['cat', 'examples/illustration/rejected/order-flow-v1.md'],
    ],
    index: [
      ['find_rules', { for: 'illustration' }],
      ['read_source', { path: 'guidance/illustrations.md', section: 'Objects, not words' }],
      ['read_source', { path: 'guidance/illustrations.md', section: 'Color' }],
      ['read_source', { path: 'guidance/arrows.md', section: 'Callout arrows' }],
      ['find_symbol', { name: '--crust' }],
      ['list_source', { path: 'icons' }],
      ['find_examples', { for: 'illustration' }],
    ],
  },
  {
    job: 'Draw a figure',
    title: 'Check whether a sourdough figure already exists',
    evidence: ['how-sourdough-rises.svg', 'How sourdough rises'],
    loose: [['ls', 'figures'], ['grep', 'sourdough']],
    index: [['list_source', { path: 'figures' }]],
  },
];
