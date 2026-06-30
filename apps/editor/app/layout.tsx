import { Inter, Inter_Tight, JetBrains_Mono } from 'next/font/google'
import './globals.css'

// Ritn3D 2026-06-18: match the webapp font stack — Inter body, Inter Tight
// display, JetBrains Mono micro-caps. Replaced Geist + Barlow. Same CSS-var
// slot names (--font-sans / --font-mono) reused so existing classes work.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
})
const interTight = Inter_Tight({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
})
const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      className={`${inter.variable} ${interTight.variable} ${jetbrains.variable}`}
      lang="en"
    >
      <head />
      <body className="font-sans bg-paper text-ink">
        {children}
      </body>
    </html>
  )
}
