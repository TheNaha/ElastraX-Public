-- V7.14: Deduplicate user identities and enforce one row per LID/PN.
DELETE FROM user_identities
WHERE lid IS NOT NULL
  AND rowid NOT IN (
    SELECT MAX(rowid)
    FROM user_identities
    WHERE lid IS NOT NULL
    GROUP BY lid
  );

DELETE FROM user_identities
WHERE pn IS NOT NULL
  AND rowid NOT IN (
    SELECT MAX(rowid)
    FROM user_identities
    WHERE pn IS NOT NULL
    GROUP BY pn
  );

CREATE UNIQUE INDEX IF NOT EXISTS user_identities_lid_unique_idx ON user_identities (lid);
CREATE UNIQUE INDEX IF NOT EXISTS user_identities_pn_unique_idx ON user_identities (pn);
