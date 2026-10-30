// control characters (not the newline), line and paragraph separators, and every format character (bidi overrides,
// zero-width joiners…): they make text read differently than it is
const STRIP = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/gu

/** How many combining marks may sit on one character: enough for real scripts (Thai, Devanagari, Vietnamese), too few
 *  to stack text over the lines around it. */
export const MAX_MARKS = 3
const STACK = new RegExp(`(\\p{M}{${MAX_MARKS}})\\p{M}+`, 'gu')

/** The one normal form for any text that is stored or shown: player input and model output alike. */
export const tidy = (s: string) => s.normalize('NFC').replace(/\r\n?/g, '\n').replace(STRIP, '').replace(STACK, '$1').replace(/\n{3,}/g, '\n\n').trim()

export const clip = (s: string, n: number) => [...s].slice(0, n).join('')

/** A name as lowercase words joined by _ ("Northwind Hosting" is "northwind_hosting"); empty when no letter or digit. */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
