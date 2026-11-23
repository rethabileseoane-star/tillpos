export const STUDIES = [
  {
    id: 'ice',
    index: 'A',
    name: 'Ice Flow',
    tagline: 'Approved reference · pale cyan flow',
    description:
      'Full-bleed approved reference image. Bright icy-white pools with flowing pale cyan glass ribbons and soft chrome highlights.',
    swatch: 'linear-gradient(135deg, #ffffff 0%, #dff6ff 38%, #8edff2 72%, #ffffff 100%)',
    engine: 'Image · approved reference',
    fallback: 'CSS ice fallback',
  },
  {
    id: 'chrome',
    index: 'B',
    name: 'Liquid Chrome',
    tagline: 'Approved reference · deep blue chrome',
    description:
      'Full-bleed approved reference image. Rich liquid chrome ribbon with cyan-blue reflections and soft blue shadows.',
    swatch:
      'linear-gradient(135deg, #ffffff 0%, #d7e7ef 30%, #f8fdff 52%, #79d8ef 76%, #ffffff 100%)',
    engine: 'Image · approved reference',
    fallback: 'CSS chrome fallback',
  },
  {
    id: 'aurora',
    index: 'C',
    name: 'Glass Aurora',
    tagline: 'Approved reference · iridescent glass',
    description:
      'Full-bleed approved reference image. Iridescent glass tubes with rainbow reflections and pale ice-blue light.',
    swatch:
      'linear-gradient(125deg, #ffffff 0%, #d8f7ff 32%, #a8e8f6 58%, #eaf9ff 82%, #ffffff 100%)',
    engine: 'Image · approved reference',
    fallback: 'CSS aurora layers',
  },
  {
    id: 'crystal',
    index: 'D',
    name: 'Crystal Waves',
    tagline: 'Approved reference · light blue crystal',
    description:
      'Full-bleed approved reference image. Light blue crystal liquid with rounded droplets and glossy reflections.',
    swatch:
      'linear-gradient(135deg, #ffffff 0%, #e8f7ff 34%, #b9dff1 66%, #ffffff 100%)',
    engine: 'Image · approved reference',
    fallback: 'CSS wave layers',
  },
] as const

export type Study = (typeof STUDIES)[number]
export type StudyId = Study['id']
