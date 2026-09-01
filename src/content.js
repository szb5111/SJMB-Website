/**
 * content.js — data the runtime needs: identity, the playlist, the nav map.
 * Prose lives in index.html so the page is fully readable without JavaScript.
 * Copy is drawn from shanejmbrower.com, "Shane Brower Web Copy v1" and
 * "THE INTERNAL BRAND BRIEF: SHANE BROWER". Keep Shane's voice: warm, nerdy,
 * cinematic, anti-ego. No corporate filler.
 */

export const IDENTITY = {
  name: 'Shane J. M. Brower',
  shortName: 'Shane Brower',
  roles: ['Producer', 'Mix Engineer', 'Riff Wrangler'],
  location: 'Jersey City, NJ',
  tagline: 'Mythos Amplified',
  pitch: 'Chaos control for bands with big ideas.',
  bookingUrl: 'https://calendly.com/szb5111/discovery-call',
  email: 'szb5111@gmail.com',
  management: { name: 'Carl Bahner', company: 'Studio Land Management', email: 'carl@studiolandmgmt.com' },
  videoId: 'PJmQjqcl3fU'
};

/** Portfolio playlist — audio + artwork self-hosted in /assets. */
export const TRACKS = [
  { id: 'mirrors',         artist: 'Shane Brower & Jerry Saunders', title: 'Mirrors',                            genre: 'Introspective Metalcore',   duration: 304.09, audio: 'assets/audio/mirrors.mp3',         art: 'assets/art/mirrors.jpg',         credit: 'Produced · Mixed · Performed', accent: '#FF8A4C' },
  { id: 'step-on-through', artist: 'Big Sweater',                   title: 'Step on Through',                    genre: 'Modern Throwback · 80s Alt', duration: 208.75, audio: 'assets/audio/step-on-through.mp3', art: 'assets/art/step-on-through.jpg', credit: 'Mixed · Mastered',             accent: '#7FB4FF' },
  { id: 'clairvoyant',     artist: 'Rico Cabredo',                  title: 'Clairvoyant',                        genre: 'Emo · Pop-Punk Acoustic',    duration: 155.92, audio: 'assets/audio/clairvoyant.mp3',     art: 'assets/art/clairvoyant.jpg',     credit: 'Produced · Mixed',             accent: '#FFB067', sub: 'The Story So Far cover' },
  { id: 'would-you',       artist: 'Cathy Daniels',                 title: 'Would You',                          genre: 'Emotional Electro-Pop',      duration: 190.56, audio: 'assets/audio/would-you.mp3',       art: 'assets/art/would-you.jpg',       credit: 'Mixed · Mastered',             accent: '#9AD7E8' },
  { id: 'frontin',         artist: 'The Genre That Never Was',      title: 'Frontin’',                           genre: 'Neo-Soul · R&B · Indie Tribe', duration: 292.92, audio: 'assets/audio/frontin.mp3',       art: 'assets/art/frontin.jpg',         credit: 'Recorded · Mixed',             accent: '#FFC98A', sub: 'Pharrell cover' },
  { id: 'eden',            artist: 'Akinola Pedro',                 title: 'Eden',                               genre: 'Pop-Fuelled R&B',            duration: 152.01, audio: 'assets/audio/eden.mp3',            art: 'assets/art/eden.jpg',            credit: 'Mixed · Drum Production',      accent: '#8FD8C6' },
  { id: 'mastery',         artist: 'Joudy',                         title: 'Mastery',                            genre: 'Deafening Stoner Rock',      duration: 261.60, audio: 'assets/audio/mastery.mp3',         art: 'assets/art/mastery.jpg',         credit: 'Mixed · Mastered',             accent: '#FF7A45' }
];

export const NAV = [
  { label: 'Work',     href: '#work' },
  { label: 'Approach', href: '#approach' },
  { label: 'Services', href: '#services' },
  { label: 'About',    href: '#about' },
  { label: 'Contact',  href: '#contact' }
];

