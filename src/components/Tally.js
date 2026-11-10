'use client';

/**
 * The agreement tally — the one element carrying the product's idea.
 *
 * One square per member of the session: filled for a like, struck through for
 * a pass, hollow for a vote not yet cast. A group's position on a title is
 * readable without parsing a percentage, and the hollow squares answer the
 * question people actually ask in a group chat: who are we still waiting on?
 */
export default function Tally({ likes = 0, dislikes = 0, memberCount = 0, showPct = true }) {
  const yes = Number(likes) || 0;
  const no = Number(dislikes) || 0;
  const voted = yes + no;
  const pending = Math.max(memberCount - voted, 0);
  const pct = voted ? Math.round((yes / voted) * 100) : null;

  return (
    <div className="tally">
      <div className="tally__marks" role="img"
           aria-label={`${yes} liked, ${no} passed, ${pending} yet to vote`}>
        {Array.from({ length: yes }).map((_, i) => (
          <span key={`y${i}`} className="tally__mark tally__mark--yes" />
        ))}
        {Array.from({ length: no }).map((_, i) => (
          <span key={`n${i}`} className="tally__mark tally__mark--no" />
        ))}
        {Array.from({ length: pending }).map((_, i) => (
          <span key={`p${i}`} className="tally__mark" />
        ))}
      </div>
      {showPct && pct !== null && (
        <span className={`tally__pct ${pct >= 60 ? 'tally__pct--high' : pct <= 40 ? 'tally__pct--low' : ''}`}>
          {pct}%
        </span>
      )}
      {pending > 0 && (
        <span className="tally__label">{pending} yet to vote</span>
      )}
    </div>
  );
}
