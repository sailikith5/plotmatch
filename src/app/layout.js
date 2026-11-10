import './globals.css';
import Masthead from '@/components/Masthead';

export const metadata = {
  title: 'PlotMatch — decide together',
  description:
    'Group-aware semantic discovery for movies and books. Everyone swipes, the group gets one answer.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Masthead />
          {children}
          <footer className="colophon">
            <span>
              PlotMatch · MySQL for truth, MongoDB for similarity
            </span>
            <span>
              UE23CS351A · Database Management Systems
            </span>
          </footer>
        </div>
      </body>
    </html>
  );
}
