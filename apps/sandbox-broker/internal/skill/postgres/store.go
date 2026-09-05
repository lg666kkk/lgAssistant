package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/policy"
	"github.com/lg/personal-assistant/apps/sandbox-broker/internal/skill"
)

type Store struct {
	pool     *pgxpool.Pool
	policies *policy.Registry
}

var _ skill.Store = (*Store)(nil)

func Open(ctx context.Context, databaseURL string, policies *policy.Registry) (*Store, error) {
	if databaseURL == "" || policies == nil {
		return nil, errors.New("sandbox database URL and policy registry are required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("create sandbox skill pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to sandbox skill database: %w", err)
	}
	return &Store{pool: pool, policies: policies}, nil
}

func (store *Store) Close() { store.pool.Close() }

func (store *Store) List(ctx context.Context) ([]skill.ConfiguredSkill, error) {
	rows, err := store.pool.Query(ctx, `
SELECT s.id, s.name, s.description, s.enabled, s.created_at, s.updated_at,
       v.version, v.runtime, v.entrypoint, v.profile_id, v.image_digest,
       v.bundle_sha256, v.network, v.input_schema_path, v.output_schema_path
FROM sandbox_skills s
LEFT JOIN sandbox_skill_versions v ON v.skill_id = s.id
WHERE s.deleted_at IS NULL
ORDER BY s.id, v.created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list sandbox skills: %w", err)
	}
	defer rows.Close()
	byID := make(map[string]*skill.ConfiguredSkill)
	order := make([]string, 0)
	for rows.Next() {
		var definition skill.Definition
		var version, runtimeName, profileID, imageDigest, bundleSHA, network *string
		var inputSchema, outputSchema *string
		var entrypoint []byte
		if err := rows.Scan(
			&definition.ID, &definition.Name, &definition.Description, &definition.Enabled,
			&definition.CreatedAt, &definition.UpdatedAt, &version, &runtimeName, &entrypoint,
			&profileID, &imageDigest, &bundleSHA, &network, &inputSchema, &outputSchema,
		); err != nil {
			return nil, fmt.Errorf("scan sandbox skill: %w", err)
		}
		configured := byID[definition.ID]
		if configured == nil {
			configured = &skill.ConfiguredSkill{Definition: definition}
			byID[definition.ID] = configured
			order = append(order, definition.ID)
		}
		if version != nil {
			manifest := skill.Manifest{
				ID: definition.ID, Version: *version, Runtime: stringValue(runtimeName),
				ProfileID: stringValue(profileID), ImageDigest: stringValue(imageDigest),
				BundleSHA256: stringValue(bundleSHA), Network: stringValue(network),
				InputSchema: stringValue(inputSchema), OutputSchema: stringValue(outputSchema),
			}
			if err := json.Unmarshal(entrypoint, &manifest.Entrypoint); err != nil {
				return nil, fmt.Errorf("decode sandbox skill entrypoint: %w", err)
			}
			configured.Versions = append(configured.Versions, manifest)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read sandbox skills: %w", err)
	}
	result := make([]skill.ConfiguredSkill, 0, len(order))
	for _, id := range order {
		result = append(result, *byID[id])
	}
	return result, nil
}

func (store *Store) Upsert(ctx context.Context, definition skill.Definition) (skill.Definition, error) {
	if definition.ID == "" || definition.Name == "" {
		return skill.Definition{}, errors.New("skill id and name are required")
	}
	if definition.UpdatedBy == "" {
		return skill.Definition{}, errors.New("skill configuration actor is required")
	}
	err := store.pool.QueryRow(ctx, `
SELECT id, name, description, enabled, created_by, updated_by, created_at, updated_at
FROM upsert_sandbox_skill($1, $2, $3, $4, $5)`,
		definition.ID, definition.Name, definition.Description, definition.Enabled, definition.UpdatedBy,
	).Scan(
		&definition.ID, &definition.Name, &definition.Description, &definition.Enabled,
		&definition.CreatedBy, &definition.UpdatedBy,
		&definition.CreatedAt, &definition.UpdatedAt,
	)
	if err != nil {
		return skill.Definition{}, fmt.Errorf("upsert sandbox skill: %w", err)
	}
	return definition, nil
}

func (store *Store) Publish(ctx context.Context, version skill.Version) (skill.Version, bool, error) {
	if version.CreatedBy == "" {
		return skill.Version{}, false, errors.New("skill publication actor is required")
	}
	if err := version.Manifest.Validate(store.policies); err != nil {
		return skill.Version{}, false, err
	}
	if err := skill.VerifyBundle(version.Bundle, version.Manifest.BundleSHA256); err != nil {
		return skill.Version{}, false, err
	}
	entrypoint, err := json.Marshal(version.Manifest.Entrypoint)
	if err != nil {
		return skill.Version{}, false, err
	}
	err = store.pool.QueryRow(ctx, `
INSERT INTO sandbox_skill_versions (
  skill_id, version, runtime, entrypoint, profile_id, image_digest,
  bundle_sha256, bundle, network, input_schema_path, output_schema_path, created_by
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
RETURNING created_at`,
		version.Manifest.ID, version.Manifest.Version, version.Manifest.Runtime, entrypoint,
		version.Manifest.ProfileID, version.Manifest.ImageDigest, version.Manifest.BundleSHA256,
		version.Bundle, version.Manifest.Network, version.Manifest.InputSchema, version.Manifest.OutputSchema,
		version.CreatedBy,
	).Scan(&version.CreatedAt)
	if err == nil {
		return version, true, nil
	}
	var pgError *pgconn.PgError
	if !errors.As(err, &pgError) || pgError.Code != "23505" {
		return skill.Version{}, false, fmt.Errorf("publish sandbox skill version: %w", err)
	}
	_, current, getErr := store.getVersion(ctx, version.Manifest.ID, version.Manifest.Version, false)
	if getErr != nil {
		return skill.Version{}, false, getErr
	}
	if current.Manifest.BundleSHA256 != version.Manifest.BundleSHA256 || !sameManifest(current.Manifest, version.Manifest) {
		return skill.Version{}, false, fmt.Errorf("%w: %s@%s", skill.ErrSkillVersionConflict, version.Manifest.ID, version.Manifest.Version)
	}
	return current, false, nil
}

func (store *Store) GetVersion(ctx context.Context, id string, version string) (skill.Definition, skill.Version, error) {
	return store.getVersion(ctx, id, version, true)
}

func (store *Store) getVersion(ctx context.Context, id string, version string, requireEnabled bool) (skill.Definition, skill.Version, error) {
	var definition skill.Definition
	var published skill.Version
	var entrypoint []byte
	err := store.pool.QueryRow(ctx, `
SELECT s.id, s.name, s.description, s.enabled, s.created_at, s.updated_at,
       v.version, v.runtime, v.entrypoint, v.profile_id, v.image_digest,
       v.bundle_sha256, v.bundle, v.network, v.input_schema_path,
       v.output_schema_path, v.created_at
FROM sandbox_skills s
JOIN sandbox_skill_versions v ON v.skill_id = s.id
WHERE s.id = $1 AND v.version = $2 AND s.deleted_at IS NULL`, id, version).Scan(
		&definition.ID, &definition.Name, &definition.Description, &definition.Enabled,
		&definition.CreatedAt, &definition.UpdatedAt, &published.Manifest.Version,
		&published.Manifest.Runtime, &entrypoint, &published.Manifest.ProfileID,
		&published.Manifest.ImageDigest, &published.Manifest.BundleSHA256, &published.Bundle,
		&published.Manifest.Network, &published.Manifest.InputSchema,
		&published.Manifest.OutputSchema, &published.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return skill.Definition{}, skill.Version{}, fmt.Errorf("%w: %s@%s", skill.ErrSkillVersionNotFound, id, version)
	}
	if err != nil {
		return skill.Definition{}, skill.Version{}, fmt.Errorf("get sandbox skill version: %w", err)
	}
	published.Manifest.ID = definition.ID
	if err := json.Unmarshal(entrypoint, &published.Manifest.Entrypoint); err != nil {
		return skill.Definition{}, skill.Version{}, fmt.Errorf("decode sandbox skill entrypoint: %w", err)
	}
	if err := published.Manifest.Validate(store.policies); err != nil {
		return skill.Definition{}, skill.Version{}, fmt.Errorf("validate stored sandbox skill manifest: %w", err)
	}
	if err := skill.VerifyBundle(published.Bundle, published.Manifest.BundleSHA256); err != nil {
		return skill.Definition{}, skill.Version{}, fmt.Errorf("validate stored sandbox skill bundle: %w", err)
	}
	if requireEnabled && !definition.Enabled {
		return skill.Definition{}, skill.Version{}, fmt.Errorf("%w: %s", skill.ErrSkillDisabled, id)
	}
	return definition, published, nil
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func sameManifest(left skill.Manifest, right skill.Manifest) bool {
	leftJSON, _ := json.Marshal(left)
	rightJSON, _ := json.Marshal(right)
	return string(leftJSON) == string(rightJSON)
}
