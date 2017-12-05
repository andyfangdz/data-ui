import React from 'react';
import PropTypes from 'prop-types';

import Grid from '@vx/grid/build/grids/Grid';
import Group from '@vx/group/build/Group';
import localPoint from '@vx/event/build/localPoint';
import WithTooltip, { withTooltipPropTypes } from '@data-ui/shared/build/enhancer/WithTooltip';

import findClosestDatum from '../utils/findClosestDatum';
import Voronoi from './Voronoi';

import {
  collectDataFromChildSeries,
  componentName,
  isAxis,
  isBarSeries,
  isCirclePackSeries,
  isCrossHair,
  isDefined,
  isReferenceLine,
  isSeries,
  getChildWithName,
  getScaleForAccessor,
  numTicksForWidth,
  numTicksForHeight,
  propOrFallback,
} from '../utils/chartUtils';

import { scaleShape, themeShape } from '../utils/propShapes';

export const propTypes = {
  ...withTooltipPropTypes,
  ariaLabel: PropTypes.string.isRequired,
  children: PropTypes.node,
  width: PropTypes.number.isRequired,
  height: PropTypes.number.isRequired,
  innerRef: PropTypes.func,
  margin: PropTypes.shape({
    top: PropTypes.number,
    right: PropTypes.number,
    bottom: PropTypes.number,
    left: PropTypes.number,
  }),
  // @TODO tooltipProps
  // tooltipProps: tooltipPropsShape,
  renderTooltip: PropTypes.func,
  xScale: scaleShape.isRequired,
  yScale: scaleShape.isRequired,
  showXGrid: PropTypes.bool,
  showYGrid: PropTypes.bool,
  theme: themeShape,
  // @TODO
  // eventTrigger: PropTypes.oneOf(['voronoi', 'series', 'container']),
  useVoronoi: PropTypes.bool,
  showVoronoi: PropTypes.bool,
};

const defaultProps = {
  children: null,
  innerRef: null,
  margin: {
    top: 64,
    right: 64,
    bottom: 64,
    left: 64,
  },
  renderTooltip: null,
  showXGrid: false,
  showYGrid: false,
  theme: {},
  useVoronoi: false,
  showVoronoi: false,
};

// accessors
const getX = d => d && d.x;
const getY = d => d && d.y;
const xString = d => getX(d).toString();

class XYChart extends React.PureComponent {
  static collectScalesFromProps(props) {
    const { xScale: xScaleObject, yScale: yScaleObject, children } = props;
    const { innerWidth, innerHeight } = XYChart.getDimmensions(props);
    const { allData } = collectDataFromChildSeries(children);

    const xScale = getScaleForAccessor({
      allData,
      minAccessor: d => (typeof d.x0 !== 'undefined' ? d.x0 : d.x),
      maxAccessor: d => (typeof d.x1 !== 'undefined' ? d.x1 : d.x),
      range: [0, innerWidth],
      ...xScaleObject,
    });

    const yScale = getScaleForAccessor({
      allData,
      minAccessor: d => (typeof d.y0 !== 'undefined' ? d.y0 : d.y),
      maxAccessor: d => (typeof d.y1 !== 'undefined' ? d.y1 : d.y),
      range: [innerHeight, 0],
      ...yScaleObject,
    });

    React.Children.forEach(children, (Child) => { // Child-specific scales or adjustments here
      const name = componentName(Child);
      if (isBarSeries(name) && xScaleObject.type !== 'band') {
        const dummyBand = getScaleForAccessor({
          allData,
          minAccessor: xString,
          maxAccessor: xString,
          type: 'band',
          rangeRound: [0, innerWidth],
          paddingOuter: 1,
        });

        const offset = dummyBand.bandwidth() / 2;
        xScale.range([offset, innerWidth - offset]);
        xScale.barWidth = dummyBand.bandwidth();
        xScale.offset = offset;
      }
      if (isCirclePackSeries(name)) {
        yScale.domain([-innerHeight / 2, innerHeight / 2]);
      }
    });

    return {
      xScale,
      yScale,
    };
  }

  static getDimmensions(props) {
    const { margin, width, height } = props;
    const completeMargin = { ...defaultProps.margin, ...margin };
    return {
      margin: completeMargin,
      innerHeight: height - completeMargin.top - completeMargin.bottom,
      innerWidth: width - completeMargin.left - completeMargin.right,
    };
  }

  static getStateFromProps(props) {
    const { margin, innerWidth, innerHeight } = XYChart.getDimmensions(props);
    const { xScale, yScale } = XYChart.collectScalesFromProps(props);

    const voronoiData = React.Children.toArray(props.children).reduce((result, Child) => {
      if (isSeries(componentName(Child)) && !Child.props.disableMouseEvents) {
        return result.concat(
          Child.props.data.filter(d => isDefined(getX(d)) && isDefined(getY(d))),
        );
      }
      return result;
    }, []);

    return {
      innerHeight,
      innerWidth,
      margin,
      xScale,
      yScale,
      voronoiData,
      voronoiX: d => xScale(getX(d)),
      voronoiY: d => yScale(getY(d)),
    };
  }

  constructor(props) {
    super(props);
    // if renderTooltip is passed we return another XYChart wrapped in WithTooltip
    // therefore we don't want to compute state if the nested chart will do so
    this.state = props.renderTooltip ? {} : XYChart.getStateFromProps(props);

    this.handleMouseLeave = this.handleMouseLeave.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleContainerMouseMove = this.handleContainerMouseMove.bind(this);
  }

  componentWillReceiveProps(nextProps) {
    if ([ // recompute scales if any of the following change
      'height',
      'margin',
      'width',
      'xScale',
      'yScale',
    ].some(prop => this.props[prop] !== nextProps[prop])) {
      // @TODO update only on children updates that require new scales
      this.setState(XYChart.getStateFromProps(nextProps));
    }
  }

  getNumTicks(innerWidth, innerHeight) {
    const xAxis = getChildWithName('XAxis', this.props.children);
    const yAxis = getChildWithName('YAxis', this.props.children);
    return {
      numXTicks: propOrFallback(xAxis && xAxis.props, 'numTicks', numTicksForWidth(innerWidth)),
      numYTicks: propOrFallback(yAxis && yAxis.props, 'numTicks', numTicksForHeight(innerHeight)),
    };
  }

  handleContainerMouseMove(event) {
    const series = {};
    const { xScale, yScale } = this.state;

    // @TODO abstract to helper; error
    const gElement = event.target.ownerSVGElement.firstChild;
    const { y: mouseY } = localPoint(gElement, event);
    let closestDatum;
    let minDelta = Infinity;

    // collect data from all series that have an x value near this point
    React.Children.forEach(this.props.children, (Child, childIndex) => {
      const { disableMouseEvents, data, label } = Child.props;
      if (isSeries(componentName(Child)) && !disableMouseEvents) {
        const datum = findClosestDatum({
          data,
          getX: xScale.invert ? getX : d => getX(d) + ((xScale.barWidth || 0) / 2),
          xScale,
          event,
        });
        const key = label || childIndex;
        if (datum) {
          series[key] = datum;
          const deltaY = Math.abs(yScale(getY(datum)) - mouseY);
          closestDatum = !closestDatum || deltaY < minDelta ? datum : closestDatum;
          minDelta = Math.min(deltaY, minDelta);
        }
      }
    });

    if (Object.keys(series).length > 0) {
      this.handleMouseMove({ event, datum: closestDatum, series });
    }
  }

  handleMouseMove(args) {
    if (this.props.onMouseMove) {
      const { xScale, yScale, margin } = this.state;
      const dataCoords = {
        x: xScale(getX(args.datum)) + margin.left,
        y: yScale(getY(args.datum)) + margin.top,
      };
      this.props.onMouseMove({
        dataCoords,
        ...args,
      });
    }
  }

  handleMouseLeave() {
    if (this.props.onMouseLeave) this.props.onMouseLeave();
  }

  render() {
    if (this.props.renderTooltip) {
      return (
        <WithTooltip renderTooltip={this.props.renderTooltip}>
          <XYChart {...this.props} renderTooltip={null} />
        </WithTooltip>
      );
    }

    const {
      ariaLabel,
      children,
      showXGrid,
      showYGrid,
      theme,
      height,
      width,
      innerRef,
      onClick,
      tooltipData,
      showVoronoi,
      useVoronoi,
    } = this.props;

    const {
      innerWidth,
      innerHeight,
      margin,
      voronoiData,
      voronoiX,
      voronoiY,
      xScale,
      yScale,
    } = this.state;

    const { numXTicks, numYTicks } = this.getNumTicks(innerWidth, innerHeight);
    const barWidth = xScale.barWidth || (xScale.bandwidth && xScale.bandwidth()) || 0;
    const CrossHairs = []; // ensure these are the top-most layer
    return innerWidth > 0 && innerHeight > 0 && (
      <svg
        aria-label={ariaLabel}
        role="img"
        width={width}
        height={height}
        ref={innerRef}
      >
        <Group left={margin.left} top={margin.top}>
          {(showXGrid || showYGrid) && (numXTicks || numYTicks) &&
            <Grid
              xScale={xScale}
              yScale={yScale}
              width={innerWidth}
              height={innerHeight}
              numTicksRows={showYGrid && numYTicks}
              numTicksColumns={showXGrid && numXTicks}
              stroke={theme.gridStyles && theme.gridStyles.stroke}
              strokeWidth={theme.gridStyles && theme.gridStyles.strokeWidth}
            />}

          {React.Children.map(children, (Child) => {
            const name = componentName(Child);
            if (isAxis(name)) {
              const styleKey = name[0].toLowerCase();
              return React.cloneElement(Child, {
                innerHeight,
                innerWidth,
                labelOffset: name === 'YAxis' ? 0.7 * margin[Child.props.orientation] : 0,
                numTicks: name === 'XAxis' ? numXTicks : numYTicks,
                scale: name === 'XAxis' ? xScale : yScale,
                rangePadding: name === 'XAxis' ? xScale.offset : null,
                axisStyles: { ...theme[`${styleKey}AxisStyles`], ...Child.props.axisStyles },
                tickStyles: { ...theme[`${styleKey}TickStyles`], ...Child.props.tickStyles },
              });
            } else if (isSeries(name)) {
              return React.cloneElement(Child, {
                xScale,
                yScale,
                barWidth,
                onClick: Child.props.onClick
                  || (Child.props.disableMouseEvents ? undefined : this.handleOnClick),
                onMouseLeave: Child.props.onMouseLeave
                  || (Child.props.disableMouseEvents ? undefined : this.handleMouseLeave),
                onMouseMove: Child.props.onMouseMove
                  || (Child.props.disableMouseEvents ? undefined : this.handleMouseMove),
              });
            } else if (isCrossHair(name)) {
              CrossHairs.push(Child);
              return null;
            } else if (isReferenceLine(name)) {
              return React.cloneElement(Child, { xScale, yScale });
            }
            return Child;
          })}

          {useVoronoi &&
            <Voronoi
              data={voronoiData}
              x={voronoiX}
              y={voronoiY}
              width={innerWidth}
              height={innerHeight}
              onClick={this.handleOnClick}
              onMouseMove={this.handleMouseMove}
              onMouseLeave={this.handleMouseLeave}
              showVoronoi={showVoronoi}
            />}

          {!useVoronoi &&
            <rect
              x={0}
              y={0}
              width={innerWidth}
              height={innerHeight}
              fill="transparent"
              fillOpacity={0}
              onClick={onClick}
              onMouseMove={this.handleContainerMouseMove}
              onMouseLeave={this.handleMouseLeave}
            />}

          {tooltipData && CrossHairs.length > 0 && CrossHairs.map((CrossHair, i) => (
            React.cloneElement(CrossHair, {
              key: `crosshair-${i}`, // eslint-disable-line react/no-array-index-key
              left: (
                xScale(getX(tooltipData.datum) || 0)
                + (xScale.bandwidth ? xScale.bandwidth() / 2 : 0)
              ),
              top: yScale(getY(tooltipData.datum) || 0),
              xScale,
              yScale,
            })
          ))}
        </Group>
      </svg>
    );
  }
}

XYChart.propTypes = propTypes;
XYChart.defaultProps = defaultProps;
XYChart.displayName = 'XYChart';

export default XYChart;
