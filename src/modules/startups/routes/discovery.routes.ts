import { Router } from 'express';
import { AppDataSource } from '@shared/database/data-source';
import { Startup } from '@modules/startups/entities/Startup';
import { ensureAuthenticated } from '@shared/middlewares/ensureAuthenticated';
export const discoveryRoutes = Router();
// Bounded, card-only listing. Full profiles remain available at GET /startups/:id.
discoveryRoutes.get('/discovery', ensureAuthenticated, async (req, res) => {
  try {
    const value = (key: string) =>
      typeof req.query[key] === 'string' ? String(req.query[key]) : '';
    const page = Number(value('page') || 0),
      size = Number(value('size') || 24);
    if (
      !Number.isInteger(page) ||
      page < 0 ||
      page > 100000 ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > 48
    )
      return void res.status(400).json({ message: 'Paginação inválida.' });
    const repo = AppDataSource.getRepository(Startup);
    const base = repo
      .createQueryBuilder('s')
      .innerJoin('s.usuario', 'u')
      .where('s.status_moderacao = :status', { status: 'aprovado' })
      .andWhere('u.ativo = true');
    const query = base.clone();
    const normalize = (expr: string) =>
      'translate(lower(' +
      expr +
      "), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')";
    const normalized = (text: string) =>
      text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const pattern = (text: string) =>
      '%' + normalized(text).replace(/[\\%_]/g, '\\$&') + '%';
    if (value('q'))
      query.andWhere(
        normalize(
          "concat_ws(' ',s.nome_fantasia,s.descricao_curta,s.descricao_pitch,s.mercado_alvo,s.segmento::text,s.modelo_negocio::text,s.necessidades_adicionais::text)",
        ) + ' LIKE :search',
        { search: pattern(value('q').slice(0, 300)) },
      );
    for (const [key, column] of [
      ['segment', 'segmento'],
      ['stage', 'estagio'],
      ['model', 'modelo_negocio'],
    ])
      if (value(key))
        query.andWhere('s.' + column + '::text = :' + key, {
          [key]: value(key),
        });
    if (value('location'))
      query.andWhere(
        normalize(
          "concat_ws(' ',s.cidade,s.estado,array_to_string(s.regioes_atuacao,' '))",
        ) + ' LIKE :location',
        {
          location: pattern(
            value('location').replace('Centro-Oeste', 'centro_oeste'),
          ),
        },
      );
    if (value('investment'))
      query.andWhere('s.busca_investimento = :seeking', {
        seeking: value('investment') === 'yes',
      });
    for (const key of ['min', 'max'])
      if (value(key)) {
        const amount = Number(value(key));
        if (!Number.isFinite(amount) || amount < 0)
          return void res
            .status(400)
            .json({ message: 'Valor de investimento inválido.' });
        query.andWhere(
          '(s.capital_procurado IS NULL OR s.capital_procurado ' +
            (key === 'min' ? '>=' : '<=') +
            ' :' +
            key +
            ')',
          { [key]: amount },
        );
      }
    if (value('saved') === 'yes') {
      const ids = value('ids').split(',').filter(Boolean);
      if (
        ids.some(
          (id) =>
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              id,
            ),
        )
      )
        return void res
          .status(400)
          .json({ message: 'Identificador inválido.' });
      if (ids.length) query.andWhere('s.id IN (:...ids)', { ids });
      else query.andWhere('false');
    }
    const score =
      "(('x' || substr(md5(:scoreUser || ':' || s.id::text),1,8))::bit(32)::bigint % 101)";
    const selected = query
      .clone()
      .select([
        's.id',
        's.nomeFantasia',
        's.logoUrl',
        's.descricaoCurta',
        's.segmento',
        's.estagio',
        's.modeloNegocio',
        's.cidade',
        's.estado',
        's.regioesAtuacao',
        's.mercadoAlvo',
        's.buscaInvestimento',
        's.capitalProcurado',
        's.necessidadesAdicionais',
        's.criadoEm',
        's.atualizadoEm',
        's.statusModeracao',
      ])
      .addSelect(score, 'compatibility')
      .setParameter('scoreUser', req.user!.id);
    const sort = value('sort');
    if (sort === 'name') selected.orderBy('s.nomeFantasia', 'ASC');
    else if (sort === 'recent') selected.orderBy('s.criadoEm', 'DESC');
    else if (sort === 'investment')
      selected.orderBy('s.buscaInvestimento', 'DESC');
    else selected.orderBy('compatibility', 'DESC');
    selected
      .addOrderBy('s.id', 'ASC')
      .offset(page * size)
      .limit(size);
    const [total, result, locations, groups] = await Promise.all([
      query.getCount(),
      selected.getRawAndEntities(),
      base
        .clone()
        .select(['s.cidade AS city', 's.estado AS state'])
        .distinct(true)
        .getRawMany(),
      query
        .clone()
        .select(['s.segmento AS segment', 's.regioes_atuacao AS regions'])
        .distinct(true)
        .getRawMany(),
    ]);
    const items = result.entities.map((item, index) => ({
      ...item,
      compatibility: Number(result.raw[index].compatibility),
    }));
    res.json({
      items,
      total,
      page,
      size,
      hasMore: (page + 1) * size < total,
      facets: {
        locations: [
          ...new Set(
            locations
              .flatMap((item) => [item.city, item.state])
              .filter(Boolean),
          ),
        ].sort(),
        segments: new Set(groups.map((item) => item.segment)).size,
        regions: new Set(
          groups.flatMap((item) =>
            Array.isArray(item.regions)
              ? item.regions
              : typeof item.regions === 'string'
                ? item.regions.replace(/[{}]/g, '').split(',').filter(Boolean)
                : [],
          ),
        ).size,
      },
    });
  } catch (error) {
    console.error('Discovery query failed', error);
    res.status(500).json({ message: 'Não foi possível carregar as startups.' });
  }
});
